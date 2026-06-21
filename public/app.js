// ═══════════════════════════════════════════════════════════════════════════════
// MLB DFS Tool v2.0 — Application UI Layer
// Connects Engine.js analytics to the user interface
// ═══════════════════════════════════════════════════════════════════════════════

// ── State ─────────────────────────────────────────────────────────────────────
const STATE = {
  // Data sources
  ROO: [], STACKS3: [], STACKS5: [], DK_PLAYERS: [], POOL: [], TEAM_SCORING: {},
  ROO_SOURCES: [null, null, null],
  rooWeights: [100, 0, 0],

  // UI state
  curPos: 'ALL', luPos: 'ALL', sortCol: 'median', sortDir: -1, playerLimit: 80,
  MODE: 'roo',
  _playerPoolCache: [], _luPoolCache: [],

  // Lineup
  lineup: new Array(10).fill(null),
  lockedSlots: new Array(10).fill(false),
  generatedLineups: [],

  // Context data
  vegasData: null, parkFactors: null, weatherData: {}, stadiumData: null,
  contestSize: 1000,

  // Optimal lineups
  OPTIMAL_LINEUPS: [],
  optimalExposure: {}, optimalStacks: {},

  // Portfolio Manager import
  PM_LINEUPS: [],
  pmSort: { col: 'rank', dir: 1 },
  pmEdgeOnly: false,

  // Portfolio
  portfolioLineups: [], portfolioExposure: {}, lastPortfolioResult: null,
  playerExposureOverrides: {},
  teamExposureOverrides: {},
  projOverrides: {},      // { 'Player Name': { median, ceiling, floor, own } } — per-session projection overrides

  // Slate type
  slateType: 'classic', // 'classic' | 'showdown'

  // Backtesting
  historyData: [],

  // Live data
  confirmedLineups: {},
  statcastData: {}, pitcherStatcastData: {},
  seasonStatsData: null, // { batters: {}, pitchers: {} } from /api/season-stats
  formData: {}, blendWeights: {},
  windEffects: {}, injuryData: [],
  umpireData: {}, dvpData: {},
  bullpenData: {},
  framingRawData: {}, framingMap: {},
  sprintSpeedData: {},

  // Source-aware multiplier flags — when projection CSV already prices in park/Vegas,
  // we suppress those multipliers in scoring to avoid double-counting (the ⚠ adj badge
  // tracks the residual deviation only). Defaults assume ROO (which prices both in).
  sourceIncludesPark: true,
  sourceIncludesVegas: true,

  // Best plays analysis (from plays tab)
  lastBestPlays: null,
  bestPlaysContext: {},

  // Quick Stack widget
  quickStackSize: 4,
};

// ── DOM element cache — populated once at init, used in all hot-path functions ──
// Avoids repeated getElementById traversals (5+ per keystroke in filterPlayers).
const _EL = {};
function cacheDOM() {
  const ids = [
    'team-sel', 'game-sel', 'search-inp', 'filter-confirmed', 'filter-hide-injured',
    'player-tbody', 'player-count', 'player-more', 'median-total', 'own-avg',
    'sal-bar', 'sal-remain'
  ];
  ids.forEach(id => { _EL[id] = document.getElementById(id); });
}

// ── Debug logging ─────────────────────────────────────────────────────────────
// Persists via localStorage so the user can toggle via window.toggleDebug() and
// keep verbose output across reloads. The engine has its own _debug flag that we
// sync via Engine.setDebug() so the engine's portfolio diagnostics also gate
// correctly. Warnings/errors are NOT gated — only the chatty info-level logs.
let _debug = (() => {
  try { return localStorage.getItem('mlbdfs_debug') === '1'; } catch (e) { return false; }
})();
function dlog(...args) { if (_debug) console.log(...args); }
function dgroup(label, fn) {
  if (!_debug) return fn();
  console.group(label);
  try { fn(); } finally { console.groupEnd(); }
}
window.toggleDebug = function () {
  _debug = !_debug;
  try { localStorage.setItem('mlbdfs_debug', _debug ? '1' : '0'); } catch (e) {}
  if (window.Engine?.setDebug) Engine.setDebug(_debug);
  console.log('[mlbdfs] debug mode', _debug ? 'ON' : 'OFF');
  return _debug;
};
// Sync engine debug state on load (engine module loaded before app.js runs this)
if (window.Engine?.setDebug) Engine.setDebug(_debug);

// ── Runtime triage tools ───────────────────────────────────────────────────────
//
// Tool 1: Session error log — intercept warn/error from the moment app.js loads.
// Captures timestamped entries so window.downloadLog() can produce a JSON file.
const _sessionLog = [];
const _origWarn  = console.warn.bind(console);
const _origError = console.error.bind(console);
console.warn = (...args) => {
  _sessionLog.push({ ts: new Date().toISOString(), level: 'warn',  msg: args.map(String).join(' ') });
  _origWarn(...args);
};
console.error = (...args) => {
  _sessionLog.push({ ts: new Date().toISOString(), level: 'error', msg: args.map(String).join(' ') });
  _origError(...args);
};

window.downloadLog = function () {
  const pool = window.STATE?.POOL || [];
  const meta = {
    exportedAt: new Date().toISOString(),
    poolSize: pool.length,
    projectedCount: pool.filter(p => (p.median || 0) > 0).length,
    confirmedTeams: Object.keys(window.STATE?.confirmedLineups || {}).length,
    vegasTeams: Object.keys(window.STATE?.vegasData || {}).length,
    mode: window.STATE?.MODE || 'unknown',
  };
  const blob = new Blob(
    [JSON.stringify({ meta, entries: _sessionLog }, null, 2)],
    { type: 'application/json' }
  );
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mlbdfs-log-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  console.log('[mlbdfs] session log downloaded —', _sessionLog.length, 'entries');
};

// Tool 2: window.diag() — one-shot structured state snapshot.
window.diag = function () {
  const S = window.STATE || {};
  const pool = S.POOL || [];
  const pitchers = pool.filter(p => (p.rosterPos || p.dkPos || '').includes('P'));
  const batters  = pool.filter(p => !(p.rosterPos || p.dkPos || '').includes('P'));

  const projPitchers = pitchers.filter(p => (p.median || 0) > 0);
  const projBatters  = batters.filter(p => (p.median || 0) > 0);
  const confirmedPlayers = pool.filter(p => p.isConfirmed === true);
  const unconfirmedTeams = [...new Set(
    pool.filter(p => p.isConfirmed === false && !p.isOpener).map(p => p.team)
  )];
  const teamsWithVegas = Object.keys(S.vegasData || {});
  const teamsInPool    = [...new Set(pool.map(p => p.team).filter(Boolean))];
  const teamsNoVegas   = teamsInPool.filter(t => !teamsWithVegas.includes(t));

  // realisticMin per slot — requires Engine + pool
  let slotMins = null;
  try {
    if (window.Engine?.DK_SLOTS && projPitchers.length) {
      const slots = Engine.DK_SLOTS;
      const preplacedNames = new Set();
      const openSlotRankByKey = {};
      slotMins = slots.map(slot => {
        const rank = openSlotRankByKey[slot.key] = (openSlotRankByKey[slot.key] || 0);
        openSlotRankByKey[slot.key]++;
        const eligible = pool.filter(p =>
          slot.eligible(p) && p.salary > 0 && ((p.median || 0) > 0 || (p.ceiling || 0) > 0) &&
          !preplacedNames.has(p.name)
        ).sort((a, b) => a.salary - b.salary);
        if (!eligible.length) return { slot: slot.key, min: 3000, note: 'no eligible players' };
        const baseIdx = Math.max(0, Math.floor(eligible.length * 0.03));
        const picked = eligible[Math.min(baseIdx + rank, eligible.length - 1)];
        return { slot: slot.key, min: picked.salary, example: picked.name };
      });
    }
  } catch (_) {}

  const snap = {
    '--- POOL ---': null,
    poolTotal:       pool.length,
    pitchers:        `${projPitchers.length} projected / ${pitchers.length} total`,
    batters:         `${projBatters.length} projected / ${batters.length} total`,
    confirmed:       `${confirmedPlayers.length} players confirmed`,
    unconfirmedTeams: unconfirmedTeams.length ? unconfirmedTeams.join(', ') : 'all teams confirmed',
    '--- COVERAGE ---': null,
    vegasTeams:      `${teamsWithVegas.length} teams with Vegas data`,
    teamsNoVegas:    teamsNoVegas.length ? teamsNoVegas.join(', ') : 'none',
    confirmedGames:  Object.keys(S.confirmedLineups || {}).length + ' games',
    ownershipFlags:  (S.ownershipFlags || []).map(f => `${f.name} ${f.uploadedOwn}%→${f.projectedOwn}%`).join(', ') || 'none',
    '--- SLOT MINS ---': null,
    realisticMin:    slotMins
      ? slotMins.map(s => `${s.slot}=$${s.min}${s.example ? `(${s.example})` : ''}`).join('  ')
      : 'unavailable (load pool first)',
    '--- SESSION ---': null,
    logEntries:      _sessionLog.length,
    warnings:        _sessionLog.filter(e => e.level === 'warn').length,
    errors:          _sessionLog.filter(e => e.level === 'error').length,
    lastPortfolio:   S.lastPortfolioReceipt
      ? `${S.lastPortfolioReceipt.generated}/${S.lastPortfolioReceipt.requested} lineups, ${S.lastPortfolioReceipt.elapsedMs}ms`
      : 'none',
    hint:            'window.downloadLog() to export full log as JSON',
  };

  console.group('%c[mlbdfs] diag snapshot', 'font-weight:bold;color:#4a9eff');
  Object.entries(snap).forEach(([k, v]) => {
    if (v === null) console.groupCollapsed('%c' + k, 'color:#aaa;font-style:italic');
    else if (k.startsWith('---')) console.groupEnd();
    else console.log('%c' + k + '%c', 'color:#888', '', v);
  });
  console.groupEnd();
  return snap;
};

// ── Constants (from Engine) ────────────────────────────────────────────────────
const SALARY_CAP = 50000, CAP = SALARY_CAP, ROSTER_SIZE = 10;
const DK_SLOTS = Engine.DK_SLOTS;
const SHOWDOWN_SALARY_CAP = Engine.SHOWDOWN_SALARY_CAP;
const SHOWDOWN_ROSTER_SIZE = Engine.SHOWDOWN_ROSTER_SIZE;
const DISPLAY_LIMIT = 80, MIN_SALARY_PER_SLOT = 3000, OPTIMIZER_ITERATIONS = 5000;

// Returns the active slot definitions based on current slate type
function activeSlots() { return STATE.slateType === 'showdown' ? Engine.SHOWDOWN_SLOTS : DK_SLOTS; }
function activeRosterSize() { return STATE.slateType === 'showdown' ? SHOWDOWN_ROSTER_SIZE : ROSTER_SIZE; }
function activeSalaryCap() { return STATE.slateType === 'showdown' ? SHOWDOWN_SALARY_CAP : SALARY_CAP; }

// ── Utilities ─────────────────────────────────────────────────────────────────
const n = v => parseFloat(v) || 0;
function rp(p, slot) { return Engine.rp(p, slot); }

// Normalize team abbreviations from various sources (Baseball Reference, FanGraphs,
// ESPN, MLB Stats API) to the DraftKings short codes that the pool uses. Without this,
// stacks/scoring data using CHW/SFG/KCR/WAS appear as off-slate teams because they
// don't match the DK pool's CWS/SF/KC/WSH abbreviations.
//
// Only includes the codes that ACTUALLY differ across common feeds — most teams
// use the same abbreviation everywhere (NYY, NYM, BOS, ATL, LAD, etc.).
const _TEAM_ALIASES = {
  // Baseball Reference / FanGraphs style → DK
  WAS: 'WSH', WSN: 'WSH',         // Washington Nationals
  CHW: 'CWS', CHA: 'CWS',         // Chicago White Sox
  SFG: 'SF',                       // San Francisco Giants
  KCR: 'KC',                       // Kansas City Royals
  TBR: 'TB',                       // Tampa Bay Rays
  SDP: 'SD',                       // San Diego Padres
  // MLB Stats API quirks
  AZ: 'ARI',                       // Arizona Diamondbacks
  // Athletics rebrand: DK now uses ATH (Sacramento Athletics, 2025+). Old
  // projection/stack CSVs using OAK get translated FORWARD to the current DK code.
  // (Previous version of this map went the wrong direction, ATH→OAK, which caused
  // stacks to appear off-slate against an ATH-coded DK pool.)
  OAK: 'ATH',
  // Retrosheet historical codes (uncommon but harmless to map)
  CHN: 'CHC', NYA: 'NYY', NYN: 'NYM', LAN: 'LAD', ANA: 'LAA',
};
function normalizeTeamAbbr(t) {
  if (!t) return '';
  const up = String(t).trim().toUpperCase();
  return _TEAM_ALIASES[up] || up;
}
function posMatchFilter(p, f) { if (f === 'ALL') return true; if (f === 'SP') return rp(p, 'P'); return rp(p, f); }
function toRosterPos(dkPos) {
  return dkPos.split('/').map(x => { const t = x.trim(); return (t === 'SP' || t === 'RP') ? 'P' : t; }).join('/');
}
function esc(s) { const d = document.createElement('div'); d.textContent = String(s || ''); return d.innerHTML; }
function cacheAgeWarning(fetchedAt) {
  if (!fetchedAt) return '';
  const ageMs = Date.now() - new Date(fetchedAt).getTime();
  const ageH = Math.round(ageMs / 3600000);
  if (ageH > 48) return ` <span class="warn">⚠ ${ageH}h old cache — click Refresh</span>`;
  return '';
}
let _toastTimer = null;
function showToast(msg, type = 'warn', duration = 3000, undoFn = null) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  clearTimeout(_toastTimer);
  const undoBtn = undoFn ? `<button class="toast-undo" onclick="event.stopPropagation()">Undo</button>` : '';
  container.innerHTML = `<div class="toast ${type}">${msg}${undoBtn}</div>`;
  const toast = container.firstChild;
  if (undoFn) {
    toast.querySelector('.toast-undo').addEventListener('click', () => { undoFn(); toast.classList.remove('show'); });
  }
  requestAnimationFrame(() => toast.classList.add('show'));
  _toastTimer = setTimeout(() => { toast.classList.remove('show'); setTimeout(() => { container.innerHTML = ''; }, 300); }, duration);
}
function escAttr(s) { return String(s || '').replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
const debouncedRenderPlayers = debounce(() => renderPlayers(), 150);
function addPlayerByPoolIdx(idx) { const p = STATE._playerPoolCache[idx]; if (p) addToLineup(p); }
function addPlayerByLuIdx(idx) { const p = STATE._luPoolCache[idx]; if (p) addToLineup(p); }
function addStackPlayer(sid, pidx) { const s = [...STATE.STACKS3, ...STATE.STACKS5].find(st => st.id === sid); if (s && s.players[pidx]) addToLineupByName(s.players[pidx]); }

// ── Projection Override Modal ─────────────────────────────────────────────────
let _overrideTarget = null;

function openOverrideModal(name) {
  _overrideTarget = name;
  const nameEl = document.getElementById('po-name');
  if (nameEl) nameEl.textContent = name;
  const ov = STATE.projOverrides[name] || {};
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val != null ? val : ''; };
  set('po-median', ov.median);
  set('po-ceiling', ov.ceiling);
  set('po-floor', ov.floor);
  set('po-own', ov.own);
  const statusEl = document.getElementById('po-status');
  if (statusEl) statusEl.textContent = '';
  document.getElementById('proj-override-backdrop').style.display = 'block';
  document.getElementById('proj-override-modal').style.display = 'block';
}

function closeOverrideModal() {
  document.getElementById('proj-override-backdrop').style.display = 'none';
  document.getElementById('proj-override-modal').style.display = 'none';
  _overrideTarget = null;
}

function applyOverrideModal() {
  if (!_overrideTarget) return;
  const get = id => { const v = parseFloat(document.getElementById(id)?.value); return isNaN(v) ? null : v; };
  const ov = { median: get('po-median'), ceiling: get('po-ceiling'), floor: get('po-floor'), own: get('po-own') };
  const hasAny = Object.values(ov).some(v => v != null);
  if (!hasAny) {
    const statusEl = document.getElementById('po-status');
    if (statusEl) statusEl.textContent = 'No values entered.';
    return;
  }
  STATE.projOverrides[_overrideTarget] = ov;
  applyProjOverridesToPool();
  invalidatePlayerRenderCache();
  renderPlayers();
  saveSession();
  const statusEl = document.getElementById('po-status');
  if (statusEl) { statusEl.textContent = 'Override applied.'; statusEl.style.color = 'var(--tsu)'; }
  setTimeout(() => closeOverrideModal(), 700);
}

function clearOverrideModal() {
  if (!_overrideTarget) return;
  delete STATE.projOverrides[_overrideTarget];
  applyProjOverridesToPool();
  invalidatePlayerRenderCache();
  renderPlayers();
  saveSession();
  closeOverrideModal();
}

function applyProjOverridesToPool() {
  STATE.POOL.forEach(p => {
    const ov = STATE.projOverrides[p.name];
    if (!ov) {
      // Restore original values when override is removed
      if (p._origProj) { Object.assign(p, p._origProj); delete p._origProj; }
      return;
    }
    if (!p._origProj) p._origProj = { median: p.median, ceiling: p.ceiling, floor: p.floor, own: p.own };
    if (ov.median != null) p.median = ov.median;
    if (ov.ceiling != null) p.ceiling = ov.ceiling;
    if (ov.floor != null) p.floor = ov.floor;
    if (ov.own != null) { p.own = ov.own; p.lev = Engine.calcLeverage(p, STATE.contestSize); }
  });
}

function updatePlayerOwn(idx, val) {
  const p = STATE._playerPoolCache[idx];
  if (!p) return;
  p.own = Math.max(0, parseFloat(val) || 0);
  p.lev = Engine.calcLeverage(p, STATE.contestSize);
}

function getPitcherMatchupBonus(pitcher) {
  if (!rp(pitcher, 'P') || !pitcher.opp) return 0;
  const oppBatters = STATE.POOL.filter(p => p.team === pitcher.opp && !rp(p, 'P') && p.median > 0);
  if (oppBatters.length < 3) return 0;
  const avg = oppBatters.reduce((s, p) => s + p.median, 0) / oppBatters.length;
  if (avg < 5) return 2; if (avg < 7) return 1; if (avg > 9) return -1; return 0;
}

function getEngineContext() {
  const pool = Engine.calibratePool(STATE.POOL);
  // hasConfirmedData: true only when confirmed lineups have been fetched this session.
  // Detected by checking if any player in the pool has been marked confirmed.
  // Without this flag, unconfirmedMultiplier is a no-op so pre-fetch runs are unaffected.
  const hasConfirmedData = STATE.POOL.some(p => p.isConfirmed === true);

  // Sync vegasData to engine so getCorrelation can apply game-O/U-aware scaling.
  // Called here (rather than tracking every vegasData write) since this runs before
  // every scoring/sim/optimizer call — guarantees correlation math sees current state.
  if (Engine.setVegasContext) Engine.setVegasContext(STATE.vegasData);
  return { vegasData: STATE.vegasData, parkFactors: STATE.parkFactors, weatherData: STATE.weatherData, stadiums: STATE.stadiumData, teamScoring: STATE.TEAM_SCORING, contestSize: STATE.contestSize, pool, optimalExposure: STATE.optimalExposure, optimalStacks: STATE.optimalStacks, umpireData: STATE.umpireData, blendWeights: STATE.blendWeights, bullpenData: STATE.bullpenData, framingMap: STATE.framingMap, sprintSpeedData: STATE.sprintSpeedData, dvpData: STATE.dvpData, hasConfirmedData,
    sourceIncludesPark: STATE.sourceIncludesPark, sourceIncludesVegas: STATE.sourceIncludesVegas, bestPlaysContext: STATE.bestPlaysContext, useBestPlaysWeighting: document.getElementById('port-use-best-plays')?.checked || false };
}

// Returns calibrated pool for optimizer calls — scoring functions score individual
// players from this pool, so calibration must be applied at the pool level
// Normalize server-side MLB API abbreviations to the DK abbreviations used in the salary CSV.
// Must stay in sync with MLB_TO_DK_ABBR in server.js — add here any abbr that resolveTeamAbbr
// could return but DK salary files wouldn't use.
const _DK_ABBR_NORM = { OAK: 'ATH', AZ: 'ARI', WAS: 'WSH', SDP: 'SD', SFG: 'SF', TBR: 'TB', KCR: 'KC' };
const _toDK = abbr => (abbr && _DK_ABBR_NORM[abbr]) || abbr;

function getCalibratedPool() {
  // Teams that have a confirmed batting order posted — non-starters from these teams are excluded.
  const confirmedTeams = new Set();
  // Teams where a probable starting pitcher has been announced — non-starters excluded.
  const teamsWithProbable = new Set();
  Object.values(STATE.confirmedLineups).forEach(g => {
    if (g.homeOrder?.length > 0) confirmedTeams.add(_toDK(g.homeTeam));
    if (g.awayOrder?.length > 0) confirmedTeams.add(_toDK(g.awayTeam));
    if (g.homeProbable) teamsWithProbable.add(_toDK(g.homeTeam));
    if (g.awayProbable) teamsWithProbable.add(_toDK(g.awayTeam));
  });

  // Manually banned players entered in the "Ban Players" field (applies to all optimizer builds).
  const bannedNames = new Set(
    (document.getElementById('port-ban-players')?.value || '')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean)
  );

  return Engine.calibratePool(STATE.POOL.filter(p => {
    if (bannedNames.size > 0 && bannedNames.has(p.name.toLowerCase())) return false; // manually banned
    if (p.dkStatus === 'O' || p.dkStatus === 'D') return false; // Out or Doubtful per DK salary file
    if (p.injuryType === 'IL' || p.injuryType === 'DL' || (p.injuryFlag && !p.injuryType)) return false; // injury API confirmed IL/DL or flagged with unknown type
    // Min-salary placeholder with no projection — scratched/inactive roster spot
    if (p.salary > 0 && p.salary <= 3000 && p.median === 0 && p.ceiling === 0 && !p.avgPpg) return false;
    // Batter whose team has posted its lineup but they're not in it — sitting out today
    if (!rp(p, 'P') && confirmedTeams.has(p.team) && !p.isConfirmed) return false;
    // Pitcher on a team with a named probable starter but this pitcher isn't it — not starting today
    if (rp(p, 'P') && teamsWithProbable.has(p.team) && !p.isConfirmed) return false;
    return true;
  }));
}

// ── Tab Navigation ────────────────────────────────────────────────────────────
function showTab(t) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(tb => tb.classList.remove('active'));
  const panel = document.getElementById('panel-' + t);
  if (panel) panel.classList.add('active');
  const tabs = document.querySelectorAll('.tab');
  const map = { upload: 0, players: 1, stacks: 2, vegas: 3, lineup: 4, portfolio: 5, simulator: 6, backtest: 7, slate: 8, plays: 9 };
  if (map[t] !== undefined && tabs[map[t]]) tabs[map[t]].classList.add('active');

  // Load data for specific tabs
  if (t === 'vegas') loadVegasWeatherData();
  if (t === 'backtest') loadHistory();
  if (t === 'slate') renderSlateSummary();
  if (t === 'plays') renderBestPlays();
  if (t === 'portfolio') renderPortfolioTeamSelectors();
  if (t === 'simulator' && !STATE.simBenchmarksLoaded) loadSimBenchmarks();
  if (t === 'players' && STATE.POOL.length && !Object.keys(STATE.confirmedLineups).length) {
    // Auto-fetch confirmed lineups once per session when switching to Players tab
    const today = new Date().toISOString().split('T')[0];
    loadConfirmedLineups(today);
  }
}

// ── Drag & Drop ───────────────────────────────────────────────────────────────
function handleDrag(e, on) { e.preventDefault(); document.getElementById('dropzone').classList.toggle('drag', on); }
function handleDrop(e) { e.preventDefault(); handleDrag(e, false); handleFiles(e.dataTransfer.files); }
function handleFiles(files) { Array.from(files).forEach(f => parseFile(f)); }

// ── File Detection & Parsing ──────────────────────────────────────────────────
function detectFileType(fields) {
  const h = fields.map(x => (x || '').toLowerCase().replace(/\s+/g, '_'));
  if (h.some(x => x === 'name_+_id' || x.includes('name_+_id')) || (h.includes('teamabbrev') && h.includes('roster_position') && h.includes('salary'))) return 'dk';
  // Team scoring file: detect by characteristic headers like oppSP, avgScore, winPercentage, eightPlusRuns
  const hasOppSP = h.some(x => x === 'opp_sp' || x === 'oppsp');
  const hasAvgScore = h.some(x => x === 'avg_score' || x === 'avgscore');
  const has8Runs = h.some(x => x.includes('8+') || x.includes('eightplusruns') || x.includes('eight_plus'));
  const hasWinPct = h.some(x => x === 'win_%' || x === 'winpercentage' || x === 'win_pct' || x === 'winpct');
  if (hasOppSP && hasAvgScore && (has8Runs || hasWinPct)) return 'team_scoring';

  const hasBatterCols = h.some(x => /^b[0-9]|^__[0-9]/.test(x));
  const hasSalary = h.includes('salary');
  if (hasBatterCols && hasSalary) return 'stacks';
  const hasFloor = h.some(x => x.includes('floor'));
  const hasMedian = h.some(x => x.includes('median') || x === 'proj' || x === 'projection' || x === 'fpts' || x === 'score');
  const hasCeiling = h.some(x => x.includes('ceiling') || x.includes('upside') || x === 'max');
  const hasPosition = h.includes('position');
  if (hasFloor && hasMedian && hasCeiling && hasPosition) return 'roo';
  if (hasFloor && hasMedian && hasCeiling) return 'roo';
  const hasProjVal = h.some(x => x === 'projected_value' || x === 'projected_fp');
  const hasStdDev = h.some(x => x === 'std_dev');
  if (hasProjVal && hasStdDev && hasPosition) return 'roo';

  // Portfolio Manager export — unique markers: se_score + lineup_edge + geomean
  // Must be checked before optimal detection (shares SP1/SP2/Stack columns).
  const hasSEScore = h.some(x => x === 'se_score');
  const hasLineupEdge = h.some(x => x === 'lineup_edge');
  const hasGeomean = h.some(x => x === 'geomean');
  if (hasSEScore && hasLineupEdge && hasGeomean) return 'pm_export';

  // Optimal lineups file — classic: SP1/SP2/C/1B/2B/3B/SS/OF1/OF2/OF3 + Salary + Proj + Stack
  const hasSP1 = h.some(x => x === 'sp1');
  const hasSP2 = h.some(x => x === 'sp2');
  const hasC = h.includes('c');
  const hasOF1 = h.some(x => x === 'of1');
  const hasStack = h.includes('stack');
  const hasProj = h.some(x => x === 'proj' || x === 'projected' || x === 'projection');
  if (hasSP1 && hasSP2 && hasC && hasOF1 && (hasStack || hasProj)) return 'optimal';

  // Optimal lineups file — showdown: CPT + FLEX1/FLEX2/.../FLEX5 or repeated FLEX columns
  const hasCpt = h.some(x => x === 'cpt');
  const flexCount = h.filter(x => x === 'flex' || /^flex[1-9]$/.test(x)).length;
  if (hasCpt && flexCount >= 4) return 'optimal_showdown';

  return 'unknown';
}

function detectStackSize(fname, data) {
  const low = (fname || '').toLowerCase();
  if (/3.?man|_3[^0-9]|three/i.test(low)) return 3;
  if (/5.?man|_5[^0-9]|five/i.test(low)) return 5;
  if (!data.length) return 3;
  const firstRow = data[0];
  const allCols = Object.keys(firstRow);
  const batterCols = allCols.filter(col => /^b[0-9]/i.test(col)).sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
  return batterCols.length >= 5 ? 5 : 3;
}

function parseFile(file) {
  Papa.parse(file, {
    header: true, skipEmptyLines: true, complete(res) {
      const type = detectFileType(res.meta.fields || []);
      if (type === 'dk') loadDK(res.data, file.name);
      else if (type === 'roo') { const idx = nextRooSlot(); loadROO(res.data, file.name, idx); }
      else if (type === 'stacks') loadStackFile(res.data, file.name);
      else if (type === 'team_scoring') loadTeamScoring(res.data, file.name);
      else if (type === 'optimal') loadOptimalLineups(res.data, file.name);
      else if (type === 'optimal_showdown') loadShowdownOptimalLineups(res.data, file.name);
      else if (type === 'pm_export') loadPortfolioManagerExport(res.data, file.name);
      else showUploadWarn('unknown', file.name, res.meta.fields || []);
    }, error(err) {
      console.error('Parse error:', err);
      // Surface the failure visibly — previously this was a console-only error
      // and the user had no feedback that the upload silently dropped.
      showToast(`Failed to parse "${file.name}": ${err.message || err}. Check that the file is a valid CSV.`, 'warn', 7000);
    }
  });
}

function loadDK(data, fname) {
  // Detect showdown slate: Roster Position values are 'CPT' / 'FLEX'
  const isShowdown = data.some(r => {
    const rp = (r['Roster Position'] || '').trim().toUpperCase();
    return rp === 'CPT' || rp === 'FLEX';
  });
  if (isShowdown) { loadShowdownDK(data, fname); return; }

  STATE.slateType = 'classic';
  STATE.lineup = new Array(ROSTER_SIZE).fill(null);
  STATE.DK_PLAYERS = data.map(r => {
    // 'Roster Position' is the authoritative DK eligibility column — it defines exactly
    // what contest slots the player can fill, and is what DK validates against on CSV upload.
    // 'Position' is the player's real-life position (often single-value like "SS") and can
    // omit multi-position eligibility granted by DK (e.g. a SS listed as "2B/SS" in DK).
    // Prefer 'Roster Position' so generated lineups always match DK's upload validation.
    const dkPos = (r['Roster Position'] || r.Position || '').trim();
    const rosterPos = toRosterPos(dkPos);
    const name = (r.Name || '').trim();
    const id = (r.ID || '').trim();
    const nameId = (r['Name + ID'] || name + (id ? ' (' + id + ')' : '')).trim();
    const team = (r.TeamAbbrev || r.teamabbrev || '').trim();
    const gameInfo = (r['Game Info'] || '').trim();
    const gm = gameInfo.match(/^([A-Z]+)@([A-Z]+)\s*(.*)/);
    const away = gm ? gm[1] : '', home = gm ? gm[2] : '';
    const opp = team === away ? home : team === home ? away : '';
    const dkStatus = (r['Injury Indicator'] || '').trim().toUpperCase(); // 'O'=Out, 'D'=Doubtful, 'Q'=Questionable
    return { name, dkId: id, nameId, dkPos, rosterPos, team, opp, salary: n(r.Salary || 0), game: gm ? away + '@' + home : '', gameTime: gm ? gm[3] : '', avgPpg: n(r.AvgPointsPerGame || 0), floor: 0, median: 0, ceiling: 0, top: 0, own: 0, lev: 0, order: 0, hand: '', gpp: 0, hasDk: true, hasRoo: false, dkStatus };
  }).filter(p => p.name && p.salary > 0);
  setFileStatus('dk', fname, STATE.DK_PLAYERS.length + ' players');
  document.getElementById('dk-export-btn').style.display = 'inline-block';
  STATE.MODE = 'dk';
  updateShowdownIndicator();
  mergePools();
}

function loadShowdownDK(data, fname) {
  STATE.slateType = 'showdown';
  STATE.lineup = new Array(SHOWDOWN_ROSTER_SIZE).fill(null);
  let parsed = data.map(r => {
    const rosterPos = (r['Roster Position'] || '').trim().toUpperCase(); // 'CPT' or 'FLEX'
    const name = (r.Name || '').trim();
    const id = (r.ID || '').trim();
    const nameId = (r['Name + ID'] || r['Name+ID'] || name + (id ? ' (' + id + ')' : '')).trim();
    const team = (r.TeamAbbrev || r.teamabbrev || '').trim();
    const gameInfo = (r['Game Info'] || '').trim();
    const gm = gameInfo.match(/^([A-Z]+)@([A-Z]+)\s*(.*)/);
    const away = gm ? gm[1] : '', home = gm ? gm[2] : '';
    const opp = team === away ? home : team === home ? away : '';
    const dkStatus = (r['Injury Indicator'] || '').trim().toUpperCase();
    return {
      name, dkId: id, nameId,
      dkPos: rosterPos, rosterPos,
      team, opp, salary: n(r.Salary || 0),
      game: gm ? away + '@' + home : '', gameTime: gm ? gm[3] : '',
      avgPpg: n(r.AvgPointsPerGame || 0),
      floor: 0, median: 0, ceiling: 0, top: 0, own: 0, lev: 0, order: 0, hand: '', gpp: 0,
      hasDk: true, hasRoo: false,
      isCpt: rosterPos === 'CPT',
      isFlex: rosterPos === 'FLEX',
      dkStatus,
    };
  }).filter(p => p.name && p.salary > 0);

  // Some DK showdown CSVs only export CPT-slot entries (Roster Position = 'CPT' for all rows).
  // In that case synthesize FLEX entries: same player/nameId, salary = round(CPT / 1.5).
  const hasFlex = parsed.some(p => p.isFlex);
  if (!hasFlex && parsed.length > 0) {
    console.log('[Showdown DK] No FLEX rows found — synthesizing FLEX from', parsed.length, 'CPT entries.');
    const flexEntries = parsed.map(p => ({
      ...p,
      dkPos: 'FLEX', rosterPos: 'FLEX',
      salary: Math.round(p.salary / 1.5),
      isCpt: false,
      isFlex: true,
    }));
    parsed = parsed.concat(flexEntries);
  }

  STATE.DK_PLAYERS = parsed;
  setFileStatus('dk', fname, STATE.DK_PLAYERS.length + ' players (Showdown)');
  document.getElementById('dk-export-btn').style.display = 'inline-block';
  STATE.MODE = 'dk';
  updateShowdownIndicator();
  mergePools();
}

function updateShowdownIndicator() {
  const el = document.getElementById('showdown-badge');
  if (!el) return;
  if (STATE.slateType === 'showdown') {
    el.style.display = 'inline-flex';
    el.textContent = 'SHOWDOWN';
  } else {
    el.style.display = 'none';
  }
}

function nextRooSlot() {
  for (let i = 0; i < 3; i++) { if (!STATE.ROO_SOURCES[i]) return i; }
  return 0; // overwrite first if all full
}

function loadROO(data, fname, idx) {
  if (idx == null) idx = nextRooSlot();
  const parsed = data.map(rawRow => {
    // Normalize keys: trim whitespace + lowercase so column access is case-insensitive.
    // "MEDIAN", "Median", " median " all resolve to rc['median']. Preserves original
    // row on `r` for any lookup that needs exact casing (none currently).
    const rc = {};
    Object.entries(rawRow).forEach(([k, v]) => { rc[k.trim().toLowerCase()] = v; });

    const pos = (rc.position || rc.pos || '').trim();
    const own = n(rc['own%'] || rc['ownership %'] || rc.ownership || rc.own || 0);
    const projVal = n(rc['projected fp'] || rc['projected value'] || rc.projected_value || 0);
    const stdDev = n(rc['std dev'] || rc.std_dev || 0);
    // Accept "Median", "MEDIAN", "Proj", "Projection", "fpts", "score", or Projected FP/Value
    const median = n(rc.median || rc.proj || rc.projection || rc.fpts || rc.score || 0) || projVal;
    const floor = n(rc.floor || rc['floor pts'] || rc['floor points'] || rc.floor_pts || 0) || (projVal > 0 ? Math.max(0, projVal - stdDev) : 0);
    const ceil = n(rc.ceiling || rc['ceiling pts'] || rc['ceiling points'] || rc.ceiling_pts || rc.upside || rc.max || 0) || (projVal > 0 ? projVal + 2 * stdDev : 0);
    return {
      name: (rc.player || rc.name || '').trim(),
      dkPos: pos, rosterPos: toRosterPos(pos),
      // Normalize to DK abbreviations — many projection sources use WAS/CHW/SFG/KCR
      // which would mismatch against the DK pool (WSH/CWS/SF/KC) without remapping.
      team: normalizeTeamAbbr(rc.team || ''),
      opp: normalizeTeamAbbr(rc.opp || rc.opponent || ''),
      hand: (rc.hand || '').trim(), order: n(rc.order || rc['bat pos.'] || rc.bat_pos || 0),
      salary: n(rc.salary || rc.dk_salary || 0),
      floor, median, ceiling: ceil,
      top: n(rc['top_finish'] || rc.top_finish || 0),
      own, gpp: n(rc['gpp%'] || 0),
      lev: own > 0 ? (ceil / own * 10 - 10) : 0,
      dkId: '', nameId: '', avgPpg: 0, game: '', gameTime: '',
      hasDk: false, hasRoo: true
    };
  }).filter(p => p.name && (p.salary > 0 || p.median > 0));

  // ── Floor integrity check ─────────────────────────────────────────────────
  // Some ROO exports output Floor = Median × 0.10 exactly (a derived ratio, not a
  // real projection). This makes cash variance calculations wrong and silences the
  // floor-safety signal. Detect the pattern and reconstruct realistic floors.
  const playersWithMedian = parsed.filter(p => p.median > 1);
  const brokenCount = playersWithMedian.filter(p =>
    p.floor > 0 && Math.abs(p.floor / p.median - 0.10) < 0.001
  ).length;
  const brokenRate = playersWithMedian.length > 0 ? brokenCount / playersWithMedian.length : 0;

  if (brokenRate > 0.80) {
    // Reconstruct floor using order-aware minimums that match the sim engine's floor policy.
    // Pitchers: 15% (early exit / 1st-inning bust); batters: 18–28% by batting order.
    parsed.forEach(p => {
      if (p.median <= 0) return;
      const pos = (p.rosterPos || p.dkPos || '').toUpperCase();
      const isSP = pos.includes('SP') || (pos.includes('P') && !pos.includes('RP') && !pos.includes('C'));
      const order = p.order || 0;
      let mult;
      if (isSP) {
        mult = 0.15;
      } else if (order >= 1 && order <= 4) {
        mult = 0.28;
      } else if (order >= 5 && order <= 7) {
        mult = 0.22;
      } else if (order >= 8) {
        mult = 0.18;
      } else {
        mult = 0.22;
      }
      p.floor = parseFloat((p.median * mult).toFixed(2));
    });
    showToast(
      `Floor values in ${fname} appear to be Median÷10 (detected in ${Math.round(brokenRate * 100)}% of players). ` +
      `Floors have been reconstructed using order-aware minimums.`,
      'warn', 7000
    );
  }

  STATE.ROO_SOURCES[idx] = { data: parsed, fname };
  setFileStatus('roo' + (idx + 1), fname, parsed.length + ' players');
  autoBalanceWeights();
  blendROO();
  if (!STATE.DK_PLAYERS.length) STATE.MODE = 'roo';
  // Auto-detect classic slate from ROO positions: if any player has a standard
  // baseball position (P/C/1B/2B/3B/SS/OF), reset slateType to classic.
  // This prevents stale 'showdown' state from a previous load from persisting.
  const hasClassicPos = parsed.some(p => /^(P|SP|RP|C|1B|2B|3B|SS|OF)(\/|$)/i.test(p.dkPos || ''));
  if (hasClassicPos && STATE.slateType === 'showdown') {
    STATE.slateType = 'classic';
    STATE.lineup = new Array(ROSTER_SIZE).fill(null);
    updateShowdownIndicator();
  }
  mergePools();
}

function autoBalanceWeights() {
  const loaded = STATE.ROO_SOURCES.map((s, i) => s ? i : -1).filter(i => i >= 0);
  if (!loaded.length) return;
  const equal = Math.round(100 / loaded.length);
  STATE.rooWeights = [0, 0, 0];
  loaded.forEach((idx, i) => {
    STATE.rooWeights[idx] = i === loaded.length - 1 ? (100 - equal * (loaded.length - 1)) : equal;
  });
  for (let i = 0; i < 3; i++) {
    document.getElementById('wt-roo' + (i + 1)).value = STATE.rooWeights[i];
  }
}

function updateRooWeights() {
  for (let i = 0; i < 3; i++) {
    STATE.rooWeights[i] = Math.max(0, Math.min(100, parseInt(document.getElementById('wt-roo' + (i + 1)).value) || 0));
  }
  blendROO();
  mergePools();
}

function blendROO() {
  const loaded = [];
  for (let i = 0; i < 3; i++) {
    if (STATE.ROO_SOURCES[i]) loaded.push({ idx: i, data: STATE.ROO_SOURCES[i].data, weight: STATE.rooWeights[i] });
  }
  if (!loaded.length) { STATE.ROO = []; return; }
  if (loaded.length === 1) { STATE.ROO = loaded[0].data.map(p => ({ ...p })); return; }

  // Normalize weights to sum to 1.0 across loaded sources only
  const totalW = loaded.reduce((s, l) => s + l.weight, 0) || 1;
  loaded.forEach(l => { l.w = l.weight / totalW; });

  // Build per-player map: { lowerName: [{ sourceIdx, player, normalizedWeight }] }
  const playerMap = {};
  loaded.forEach(src => {
    src.data.forEach(p => {
      const key = p.name.toLowerCase();
      if (!playerMap[key]) playerMap[key] = [];
      playerMap[key].push({ p, w: src.w });
    });
  });

  // Blend projection fields, take metadata from first source
  const BLEND_FIELDS = ['floor', 'median', 'ceiling', 'top', 'own', 'gpp'];
  STATE.ROO = Object.values(playerMap).map(entries => {
    const base = { ...entries[0].p };
    // Re-normalize weights for this player (some sources may not have them)
    const pw = entries.reduce((s, e) => s + e.w, 0) || 1;
    for (const f of BLEND_FIELDS) {
      base[f] = entries.reduce((s, e) => s + e.p[f] * e.w, 0) / pw;
    }
    // If salary differs, take the max (most conservative)
    if (entries.length > 1) {
      base.salary = Math.max(...entries.map(e => e.p.salary));
    }
    base.lev = base.own > 0 ? (base.ceiling / base.own * 10 - 10) : 0;
    return base;
  });
}

function loadStackFile(data, fname) {
  if (!data.length) return;
  const size = detectStackSize(fname, data);
  const firstRow = data[0];
  const allCols = Object.keys(firstRow);
  const batterCols = allCols.filter(col => /^b[0-9]/i.test(col)).sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
  if (batterCols.length < 2) { showUploadWarn('unknown', fname, allCols); return; }

  const normalizations = new Set(); // raw→normalized pairs that actually changed
  const parsed = data.map((r, i) => {
    const players = [];
    for (const col of batterCols) {
      const v = (r[col] || '').toString().trim();
      if (v && v !== 'nan' && v !== 'NaN' && v !== '') players.push(v);
    }
    const rawTeam = (r.Team || r.team || r.Team_ || r.team_ || '').toString().trim()
      || ((r.Player || r.player || '').toString().trim().match(/^([A-Z]{2,4})\b/) || [])[1] || '';
    // Normalize Baseball Reference / FanGraphs / MLB-API style abbreviations to DK codes
    // (WAS→WSH, CHW→CWS, SFG→SF, KCR→KC, etc.) so stacks align with the loaded pool.
    const team = normalizeTeamAbbr(rawTeam);
    if (rawTeam && team !== rawTeam.toUpperCase()) normalizations.add(`${rawTeam.toUpperCase()}→${team}`);
    const proj = n(r.Proj || r.proj || r.Median || r.median || r.Proj_ || r.proj_ || 0);
    const salary = n(r.Salary || r.salary || r.Salary_ || r.salary_ || 0);
    const own = n(r['Own%'] || r['own%'] || r.Own || r.own || r.Own_ || r.own_ || 0);
    const floor = n(r.Floor || r.floor || 0);
    const ceiling = n(r.Ceiling || r.ceiling || 0);
    return { id: (size === 3 ? 's3' : 's5') + i, players, size, team, proj, salary, own, floor, ceiling };
  }).filter(s => s.players.length >= 2);
  if (normalizations.size) {
    showToast(`Stack team codes normalized to DK format: ${[...normalizations].join(', ')}. Stacks now align with the player pool.`, 'info', 6000);
  }

  if (size === 3) { STATE.STACKS3 = parsed; setFileStatus('s3', fname, parsed.length + ' 3-man stacks'); }
  else { STATE.STACKS5 = parsed; setFileStatus('s5', fname, parsed.length + ' 5-man stacks'); }

  const allStacks = [...STATE.STACKS3, ...STATE.STACKS5];
  const teams = [...new Set(allStacks.map(s => s.team))].filter(Boolean).sort();
  document.getElementById('stack-team-sel').innerHTML = '<option value="ALL">All Teams</option>' + teams.map(t => `<option value="${t}">${t}</option>`).join('');

  if (allStacks.length) {
    document.getElementById('stacks-empty').style.display = 'none';
    document.getElementById('stacks-content').style.display = 'block';
  }
  renderStacks();
  checkAllLoaded();
}

function loadTeamScoring(data, fname) {
  STATE.TEAM_SCORING = {};
  // Find a field by checking lowercased versions against candidates
  const colMap = (fields, ...candidates) => fields.find(f => {
    const low = f.toLowerCase().replace(/[\s_]+/g, '');
    return candidates.some(c => low === c || low.includes(c));
  });
  const pctVal = v => parseFloat(String(v || '0').replace('%', '')) || 0;
  data.forEach(r => {
    const fields = Object.keys(r);
    const rawTeam = (r[colMap(fields, 'names', 'team')] || r.Team || r.team || r.Names || r.names || '').trim();
    if (!rawTeam) return;
    // Normalize to DK codes so the lookup in applyTeamScoringToPool aligns with p.team
    const team = normalizeTeamAbbr(rawTeam);
    STATE.TEAM_SCORING[team] = {
      oppSP: (r[colMap(fields, 'oppsp')] || '').trim(),
      avgScore: n(r[colMap(fields, 'avgscore')] || 0),
      eightPlusRuns: pctVal(r[colMap(fields, 'eightplusruns', '8+runs', '8+_runs')]),
      dkTopScore: pctVal(r[colMap(fields, 'topscore', 'dkmaintopscore', 'dktopscore')]),
      dkTeamOwn: pctVal(r[colMap(fields, 'dkteamown', 'dkteamownpct')]),
      fdTeamOwn: pctVal(r[colMap(fields, 'fdteamown', 'fdteamownpct')]),
      winPct: pctVal(r[colMap(fields, 'winpercentage', 'winpct', 'win%')]),
      avg1st: n(r[colMap(fields, 'avgfirstinning', 'avg1st')] || 0),
      firstLeadPct: pctVal(r[colMap(fields, 'firstinningleadpct', '1stleadpct', '1stlead%')]),
      avg5th: n(r[colMap(fields, 'avgfifthinning', 'avg5th')] || 0),
      fifthLeadPct: pctVal(r[colMap(fields, 'fifthinningleadpct', '5thleadpct', '5thlead%')])
    };
  });
  const count = Object.keys(STATE.TEAM_SCORING).length;
  setFileStatus('ts', fname, count + ' teams');
  if (STATE.POOL.length) applyTeamScoringToPool();
  renderTeamScoringDisplay();
  checkAllLoaded();
}

function applyTeamScoringToPool() {
  STATE.POOL.forEach(p => {
    const ts = STATE.TEAM_SCORING[p.team];
    if (ts) {
      p.teamAvgScore = ts.avgScore;
      p.teamEightPlus = ts.eightPlusRuns;
      p.teamWinPct = ts.winPct;
      p.teamDkOwn = ts.dkTeamOwn;
    }
  });
}

// ── Optimal Lineups Loading ───────────────────────────────────────────────────
function loadOptimalLineups(data, fname) {
  const slotCols = ['SP1', 'SP2', 'C', '1B', '2B', '3B', 'SS', 'OF1', 'OF2', 'OF3'];
  // Normalize column names (case-insensitive lookup)
  const colMap = {};
  if (data.length) {
    const keys = Object.keys(data[0]);
    keys.forEach(k => { colMap[k.toLowerCase().replace(/\s+/g, '')] = k; });
  }
  const col = name => colMap[name.toLowerCase().replace(/\s+/g, '')] || name;

  STATE.OPTIMAL_LINEUPS = data.map(r => {
    const players = slotCols.map(s => (r[col(s)] || '').trim()).filter(Boolean);
    return {
      players,
      salary: parseFloat(r[col('Salary')] || r[col('salary')] || 0) || 0,
      proj: parseFloat(r[col('Proj')] || r[col('projected')] || r[col('projection')] || 0) || 0,
      stack: (r[col('Stack')] || '').trim(),
      stackCount: parseInt(r[col('#')] || 0) || 0,
      secondary: (r[col('Secondary')] || '').trim(),
      secondaryCount: 0,
      own: parseFloat(r[col('Own')] || r[col('own')] || 0) || 0
    };
  }).filter(lu => lu.players.length >= 8);

  // Handle the two "#" columns: find them by position
  if (data.length) {
    const keys = Object.keys(data[0]);
    const hashCols = keys.filter(k => k.trim() === '#');
    if (hashCols.length >= 2) {
      // Re-parse with positional awareness
      data.forEach((r, i) => {
        if (i < STATE.OPTIMAL_LINEUPS.length) {
          const vals = hashCols.map(k => parseInt(r[k] || 0) || 0);
          STATE.OPTIMAL_LINEUPS[i].stackCount = vals[0];
          STATE.OPTIMAL_LINEUPS[i].secondaryCount = vals[1];
        }
      });
    }
  }

  // Compute player exposure rates
  STATE.optimalExposure = {};
  const total = STATE.OPTIMAL_LINEUPS.length;
  STATE.OPTIMAL_LINEUPS.forEach(lu => {
    lu.players.forEach(name => {
      if (!STATE.optimalExposure[name]) STATE.optimalExposure[name] = { count: 0, pct: 0 };
      STATE.optimalExposure[name].count++;
    });
  });
  Object.keys(STATE.optimalExposure).forEach(name => {
    STATE.optimalExposure[name].pct = parseFloat((STATE.optimalExposure[name].count / total * 100).toFixed(1));
  });

  // Compute stack combo frequencies
  STATE.optimalStacks = {};
  STATE.OPTIMAL_LINEUPS.forEach(lu => {
    if (lu.stack) {
      if (!STATE.optimalStacks[lu.stack]) STATE.optimalStacks[lu.stack] = { primary: 0, secondary: 0, total: 0 };
      STATE.optimalStacks[lu.stack].primary++;
      STATE.optimalStacks[lu.stack].total++;
    }
    if (lu.secondary) {
      if (!STATE.optimalStacks[lu.secondary]) STATE.optimalStacks[lu.secondary] = { primary: 0, secondary: 0, total: 0 };
      STATE.optimalStacks[lu.secondary].secondary++;
      STATE.optimalStacks[lu.secondary].total++;
    }
  });
  // Convert to percentages
  Object.keys(STATE.optimalStacks).forEach(team => {
    STATE.optimalStacks[team].primaryPct = parseFloat((STATE.optimalStacks[team].primary / total * 100).toFixed(1));
    STATE.optimalStacks[team].secondaryPct = parseFloat((STATE.optimalStacks[team].secondary / total * 100).toFixed(1));
    STATE.optimalStacks[team].totalPct = parseFloat((STATE.optimalStacks[team].total / total * 100).toFixed(1));
  });

  // Apply optimal exposure to the player pool
  applyOptimalToPool();

  // Boost stack rankings based on optimal frequency
  applyOptimalToStacks();

  setFileStatus('opt', fname, total + ' lineups');
  checkAllLoaded();
  if (STATE.POOL.length) { renderPlayers(); renderStacks(); }
}

// Showdown optimal lineup file: columns CPT, FLEX, FLEX, FLEX, FLEX, FLEX [+ Proj, Own%, Salary]
// Tracks per-player CPT exposure separately so the optimizer can boost captain picks.
function loadShowdownOptimalLineups(data, fname) {
  if (!data.length) return;
  const keys = Object.keys(data[0]);
  // Support both repeated "FLEX" and numbered "FLEX1"–"FLEX5"
  const flexKeys = keys.filter(k => k.trim().toUpperCase() === 'FLEX' || /^FLEX[1-9]$/i.test(k.trim()));
  const cptKey = keys.find(k => k.trim().toUpperCase() === 'CPT') || 'CPT';
  const colMap = {};
  keys.forEach(k => { colMap[k.toLowerCase().replace(/\s+/g, '')] = k; });
  const col = name => colMap[name.toLowerCase().replace(/\s+/g, '')] || name;

  STATE.OPTIMAL_LINEUPS = data.map(r => {
    const cptName = (r[cptKey] || '').trim();
    const flexNames = flexKeys.map(k => (r[k] || '').trim()).filter(Boolean);
    const players = [cptName, ...flexNames].filter(Boolean);
    return {
      players,
      cptName,
      salary: parseFloat(r[col('Salary')] || r[col('salary')] || 0) || 0,
      proj: parseFloat(r[col('Proj')] || r[col('projected')] || r[col('projection')] || 0) || 0,
      own: parseFloat(r[col('Own%')] || r[col('own%')] || r[col('own')] || 0) || 0,
    };
  }).filter(lu => lu.players.length >= 4);

  // Compute exposure — track CPT appearances separately for captain boosting
  STATE.optimalExposure = {};
  const total = STATE.OPTIMAL_LINEUPS.length;
  STATE.OPTIMAL_LINEUPS.forEach(lu => {
    lu.players.forEach((name, i) => {
      if (!name) return;
      if (!STATE.optimalExposure[name]) STATE.optimalExposure[name] = { count: 0, pct: 0, cptCount: 0 };
      STATE.optimalExposure[name].count++;
      if (i === 0) STATE.optimalExposure[name].cptCount++;
    });
  });
  Object.keys(STATE.optimalExposure).forEach(name => {
    STATE.optimalExposure[name].pct = parseFloat((STATE.optimalExposure[name].count / total * 100).toFixed(1));
  });

  applyOptimalToPool();
  setFileStatus('opt', fname, total + ' showdown lineups');
  checkAllLoaded();
  if (STATE.POOL.length) { renderPlayers(); }
}

// ── Portfolio Manager Export ──────────────────────────────────────────────────

function loadPortfolioManagerExport(data, fname) {
  STATE.PM_LINEUPS = data.map((r, i) => {
    // PapaParse gives the unnamed index column an empty-string key
    const rawRank = r[''] ?? r[Object.keys(r)[0]];
    const rank = parseInt(rawRank);
    return {
      rank: isNaN(rank) ? i : rank,
      sp1: (r['SP1'] || '').trim(),
      sp2: (r['SP2'] || '').trim(),
      c:   (r['C']   || '').trim(),
      b1:  (r['1B']  || '').trim(),
      b2:  (r['2B']  || '').trim(),
      b3:  (r['3B']  || '').trim(),
      ss:  (r['SS']  || '').trim(),
      of1: (r['OF1'] || '').trim(),
      of2: (r['OF2'] || '').trim(),
      of3: (r['OF3'] || '').trim(),
      stack:      (r['Stack'] || '').trim(),
      stackSize:  parseInt(r['Size'] || 0) || 0,
      salary:     parseFloat(r['salary'] || 0) || 0,
      median:     parseFloat(r['median'] || 0) || 0,
      own:        parseFloat(r['Own'] || 0) || 0,
      finishPct:  parseFloat(r['Finish_percentile'] || 0) || 0,
      winPct:     parseFloat(r['Win%'] || 0) || 0,
      lineupEdge: parseFloat(r['Lineup Edge'] || 0) || 0,
      weightedOwn:parseFloat(r['Weighted Own'] || 0) || 0,
      geomean:    parseFloat(r['Geomean'] || 0) || 0,
      diversity:  parseFloat(r['Diversity'] || 0) || 0,
      seScore:    parseFloat(r['SE Score'] || 0) || 0,
    };
  }).filter(lu => lu.sp1 || lu.sp2);

  STATE.pmSort = { col: 'rank', dir: 1 };
  STATE.pmEdgeOnly = false;

  setFileStatus('pm', fname, STATE.PM_LINEUPS.length + ' lineups');

  const sec = document.getElementById('pm-lineups-section');
  if (sec) sec.style.display = 'block';

  // Switch to portfolio tab so the user can see the result immediately
  if (document.getElementById('panel-portfolio')?.classList.contains('active') === false) {
    showTab('portfolio');
  }

  renderPMLineups();
}

function setPMSort(col) {
  if (STATE.pmSort.col === col) {
    STATE.pmSort.dir *= -1;
  } else {
    STATE.pmSort.col = col;
    // For score-like columns default to descending; rank and salary ascending
    STATE.pmSort.dir = (col === 'rank' || col === 'salary') ? 1 : -1;
  }
  renderPMLineups();
}

function setPMEdgeOnly(v) {
  STATE.pmEdgeOnly = v;
  renderPMLineups();
}

function renderPMLineups() {
  const sec = document.getElementById('pm-lineups-section');
  if (!sec || !STATE.PM_LINEUPS?.length) return;

  const { col, dir } = STATE.pmSort;
  const edgeOnly = STATE.pmEdgeOnly;

  let lineups = [...STATE.PM_LINEUPS];
  if (edgeOnly) lineups = lineups.filter(lu => lu.lineupEdge >= 0);
  lineups.sort((a, b) => {
    const va = a[col] ?? 0, vb = b[col] ?? 0;
    return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
  });

  const total = STATE.PM_LINEUPS.length;
  const posCount = STATE.PM_LINEUPS.filter(l => l.lineupEdge >= 0).length;
  const avgSE  = STATE.PM_LINEUPS.reduce((s, l) => s + l.seScore, 0) / total;
  const avgEdge = STATE.PM_LINEUPS.reduce((s, l) => s + l.lineupEdge, 0) / total;

  const lname = s => {
    if (!s) return '—';
    const p = s.trim().split(' ');
    return p.length > 1 ? p[p.length - 1] : s;
  };

  const seColor = v => v >= 0.8 ? 'var(--tsu)' : v >= 0.5 ? 'var(--ti)' : v >= 0.2 ? 'var(--tw)' : 'var(--tt)';
  const edgeColor = v => v >= 0 ? 'var(--tsu)' : 'var(--td)';
  const edgeStr = v => (v >= 0 ? '+' : '') + v.toFixed(3);
  const arrow = c => col !== c
    ? '<span style="color:var(--tt);font-size:9px;opacity:.5">⇅</span>'
    : (dir === 1 ? ' ↑' : ' ↓');
  const th = c => `style="cursor:pointer;user-select:none;white-space:nowrap" onclick="setPMSort('${c}')"`;

  const rows = lineups.map(lu => {
    const sc = seColor(lu.seScore);
    const seW = Math.round(lu.seScore * 40);
    return `<tr>
      <td style="color:var(--tt);font-size:10px">${lu.rank + 1}</td>
      <td title="${esc(lu.sp1)}">${esc(lname(lu.sp1))}</td>
      <td title="${esc(lu.sp2)}">${esc(lname(lu.sp2))}</td>
      <td><span class="pill pg" style="font-size:9px">${esc(lu.stack)}</span></td>
      <td>$${(lu.salary / 1000).toFixed(1)}k</td>
      <td>${lu.median.toFixed(1)}</td>
      <td style="color:var(--ts)">${lu.own.toFixed(1)}%</td>
      <td>
        <div style="display:flex;align-items:center;gap:4px">
          <div style="width:40px;height:4px;background:var(--bs);border-radius:2px;overflow:hidden">
            <div style="width:${seW}px;height:4px;background:${sc}"></div>
          </div>
          <span style="color:${sc};font-weight:600;font-size:11px">${lu.seScore.toFixed(3)}</span>
        </div>
      </td>
      <td style="color:${edgeColor(lu.lineupEdge)};font-weight:600">${edgeStr(lu.lineupEdge)}</td>
      <td style="color:var(--ts)">${lu.weightedOwn.toFixed(1)}</td>
      <td style="color:var(--ts)">${lu.geomean.toFixed(2)}</td>
    </tr>`;
  }).join('');

  sec.innerHTML = `
    <div style="padding:10px 12px;background:var(--bs);border-radius:var(--r);border:0.5px solid var(--brd-s)">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap">
        <div style="font-size:12px;font-weight:600;color:var(--tp)">Portfolio Manager Import</div>
        <span style="font-size:11px;color:var(--tt)">${total} lineups &middot; ${posCount} positive edge &middot; avg SE ${avgSE.toFixed(3)} &middot; avg edge ${avgEdge >= 0 ? '+' : ''}${avgEdge.toFixed(4)}</span>
        <label style="display:flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;margin-left:auto">
          <input type="checkbox" ${edgeOnly ? 'checked' : ''} onchange="setPMEdgeOnly(this.checked)"> Edge ≥ 0 only
        </label>
      </div>
      <div style="max-height:320px;overflow-y:auto">
        <table style="font-size:11px">
          <thead><tr>
            <th ${th('rank')}># ${arrow('rank')}</th>
            <th ${th('sp1')}>SP1 ${arrow('sp1')}</th>
            <th ${th('sp2')}>SP2 ${arrow('sp2')}</th>
            <th ${th('stack')}>Stack ${arrow('stack')}</th>
            <th ${th('salary')}>Salary ${arrow('salary')}</th>
            <th ${th('median')}>Median ${arrow('median')}</th>
            <th ${th('own')}>Own% ${arrow('own')}</th>
            <th ${th('seScore')} title="Single Entry Score — higher = better for SE contests">SE Score ${arrow('seScore')}</th>
            <th ${th('lineupEdge')} title="Edge vs the field — positive = favorable">Edge ${arrow('lineupEdge')}</th>
            <th ${th('weightedOwn')} title="Portfolio-weighted ownership composite">Wgt Own ${arrow('weightedOwn')}</th>
            <th ${th('geomean')} title="Geometric mean — risk-adjusted upside score">Geomean ${arrow('geomean')}</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div style="margin-top:6px;font-size:10px;color:var(--tt)">
        Click any column header to sort &middot; SE Score and Edge are the two novel signals not in the generator
      </div>
    </div>`;
}

function applyOptimalToPool() {
  STATE.POOL.forEach(p => {
    const exp = STATE.optimalExposure[p.name];
    p.optExp = exp ? exp.pct : 0;
    // Uploaded optimizer export supersedes any prior sim-derived Opt%; clear the sim
    // source/leverage so the row renders the upload title and hides the stale leverage chip.
    p.optExpSource = 'upload';
    p.trueLev = null;
  });
}

function applyOptimalToStacks() {
  // Boost stack projection scores by optimal frequency
  const boostStacks = stacks => {
    stacks.forEach(s => {
      const os = STATE.optimalStacks[s.team];
      if (os) {
        // Store original proj if not yet stored
        if (s._origProj == null) s._origProj = s.proj;
        // Boost: up to +15% for teams that appear as primary stack in >50% of optimals
        const boostPct = Math.min(os.primaryPct / 50, 1.0) * 0.15;
        s.proj = s._origProj * (1 + boostPct);
        s.optPrimary = os.primaryPct;
        s.optSecondary = os.secondaryPct;
      }
    });
  };
  boostStacks(STATE.STACKS3);
  boostStacks(STATE.STACKS5);
}

// Warn when a player's rosterPos doesn't match any DK slot — catches bad position data
// from ROO files (e.g. 'DH', 'UTIL', 'RF/LF') that the optimizer silently ignores.
function warnUnmatchedPositions() {
  if (!STATE.POOL.length || STATE.slateType === 'showdown') return;
  const slots = DK_SLOTS;
  const unmatched = STATE.POOL.filter(p => {
    if (!p.rosterPos && !p.dkPos) return false;
    return !slots.some(s => s.eligible(p));
  });
  if (unmatched.length > 0) {
    const names = unmatched.slice(0, 5).map(p => `${p.name} (${p.rosterPos || p.dkPos})`).join(', ');
    const extra = unmatched.length > 5 ? ` and ${unmatched.length - 5} more` : '';
    console.warn(`[mlbdfs] ${unmatched.length} player(s) have unrecognised DK positions and will be excluded from lineups: ${names}${extra}`);
  }
}

function mergePools() {
  if (!STATE.DK_PLAYERS.length && !STATE.ROO.length) { STATE.POOL = []; updateUI(); return; }
  const rooMap = {};
  STATE.ROO.forEach(p => { rooMap[p.name.toLowerCase()] = p; });
  if (STATE.DK_PLAYERS.length && STATE.MODE === 'dk') {
    STATE.POOL = STATE.DK_PLAYERS.map(dk => {
      const p = { ...dk };
      const roo = rooMap[dk.name.toLowerCase()];
      if (roo) {
        p.hasRoo = true;
        // For showdown CPT players, scale projections by 1.5× to reflect the captain multiplier
        const cptMult = (STATE.slateType === 'showdown' && p.isCpt) ? 1.5 : 1.0;
        p.floor = roo.floor * cptMult; p.median = roo.median * cptMult; p.ceiling = roo.ceiling * cptMult;
        p.top = roo.top; p.own = roo.own; p.gpp = roo.gpp;
        p.order = roo.order; p.hand = roo.hand;
        if (!p.opp) p.opp = roo.opp;
        p.lev = Engine.calcLeverage(p, STATE.contestSize);
      }
      return p;
    });
    // For showdown, count unique player names for match rate (each player has CPT + FLEX entry)
    const matchedNames = new Set(STATE.POOL.filter(p => p.hasRoo).map(p => p.name.toLowerCase()));
    const rooCount = STATE.ROO.length;
    const matchPct = rooCount > 0 ? Math.round(matchedNames.size / rooCount * 100) : 100;
    if (STATE.ROO.length > 0 && matchedNames.size < STATE.ROO.length * 0.8) {
      showUploadWarn('mismatch', null, null, { matched: matchedNames.size, total: rooCount, matchPct });
    } else { hideUploadWarn('mismatch'); }
  } else {
    STATE.POOL = STATE.ROO.map(p => ({ ...p, lev: Engine.calcLeverage(p, STATE.contestSize) }));
    hideUploadWarn('mismatch');
  }
  if (Object.keys(STATE.TEAM_SCORING).length) applyTeamScoringToPool();
  if (Object.keys(STATE.optimalExposure).length) applyOptimalToPool();
  if (Object.keys(STATE.confirmedLineups).length) applyConfirmedToPool();
  if (Object.keys(STATE.projOverrides).length) applyProjOverridesToPool();
  // Apply internal projections to any player missing external ROO data
  if (STATE.seasonStatsData && Engine.buildInternalProjections) {
    STATE.POOL = Engine.buildInternalProjections(STATE.POOL, STATE.seasonStatsData, STATE.vegasData);
  }
  warnUnmatchedPositions();
  runOwnershipAudit(); // Fix #1 — validate/fill uploaded ownership before it drives leverage/sim
  invalidatePlayerRenderCache(); // pool changed — force re-filter on next render
  updateUI();
  checkAllLoaded();
  // Keep Slate Summary live: auto-refresh whenever the pool changes and the tab is open.
  if (document.getElementById('panel-slate')?.classList.contains('active')) {
    renderSlateSummary();
  }
}

// Fix #1 — Ownership input-sanity layer.
// Validates the uploaded `own` numbers (which drive all leverage/field/simROI math)
// against an internal projection, fills any missing ownership with a per-player estimate
// instead of a flat positional constant, and stores deviation flags for the UI / console.
function runOwnershipAudit() {
  if (!Engine.auditOwnership || !STATE.POOL.length) return;
  try {
    const ctx = { vegasData: STATE.vegasData, contestSize: STATE.contestSize };
    const anyUploaded = STATE.POOL.some(p => (p.own || 0) > 0);
    const { projections, flags } = Engine.auditOwnership(STATE.POOL, ctx);
    const projByName = new Map(projections.map(r => [r.name, r.projectedOwn]));
    // If a real ownership file was uploaded, only fill the gaps (own<=0) and leave
    // uploaded numbers intact. If nothing was uploaded, project ownership for everyone.
    STATE.POOL.forEach(p => {
      if (anyUploaded && (p.own || 0) > 0) { p.ownProjected = false; return; }
      const proj = projByName.get(p.name);
      if (proj != null) {
        p.own = proj;
        p.ownProjected = true;
        p.lev = Engine.calcLeverage(p, STATE.contestSize);
      }
    });
    STATE.ownershipProjections = projections;
    // Only surface deviation flags when the user actually uploaded ownership to validate.
    STATE.ownershipFlags = anyUploaded ? flags : [];
    STATE.ownershipFlagNames = new Set(STATE.ownershipFlags.map(f => f.name.toLowerCase()));
    if (STATE.ownershipFlags.length) {
      const top = STATE.ownershipFlags.slice(0, 5)
        .map(f => `${f.name} ${f.uploadedOwn}%→~${f.projectedOwn}%`).join(', ');
      console.warn(`[mlbdfs] Ownership sanity: ${STATE.ownershipFlags.length} player(s) deviate from model — ${top}`);
    }
  } catch (e) {
    console.warn('[mlbdfs] ownership audit failed:', e.message);
  }
}

// ── UI Updates ────────────────────────────────────────────────────────────────
function updateUI() {
  STATE.playerLimit = 80;
  if (!STATE.POOL.length) return;
  const mi = document.getElementById('mode-indicator');
  mi.style.display = 'inline-flex';
  if (STATE.MODE === 'dk' && STATE.DK_PLAYERS.length) {
    mi.className = 'mode-badge dk-mode'; mi.textContent = 'DK Slate Mode';
  } else {
    mi.className = 'mode-badge roo-mode'; mi.textContent = 'ROO-Only Mode';
  }
  const teams = [...new Set(STATE.POOL.map(p => p.team))].filter(Boolean).sort();
  document.getElementById('team-sel').innerHTML = '<option value="ALL">All Teams</option>' + teams.map(t => `<option value="${t}">${t}</option>`).join('');
  const games = [...new Set(STATE.POOL.map(p => p.game).filter(Boolean))].sort();
  const gsel = document.getElementById('game-sel');
  if (games.length) { gsel.style.display = ''; gsel.innerHTML = '<option value="ALL">All Games</option>' + games.map(g => `<option value="${g}">${g}</option>`).join(''); }
  else { gsel.style.display = 'none'; }
  document.getElementById('player-empty').style.display = 'none';
  document.getElementById('player-content').style.display = 'block';
  document.getElementById('lineup-empty').style.display = 'none';
  document.getElementById('lineup-content').style.display = 'block';
  updateShowdownIndicator();
  updateShowdownLineupUI();
  renderPlayers(); renderLineup(); renderLuPool(); renderStacks();
  renderOwnershipBanner();
  renderValueScatter();
  renderBlendControls();
  applyPendingLineupRestore();
}

function updateShowdownLineupUI() {
  const sd = isShowdown();

  // Lineup builder
  const tip = document.getElementById('showdown-lineup-tip');
  if (tip) tip.style.display = sd ? 'block' : 'none';
  const lbl = document.getElementById('lineup-mode-label');
  if (lbl) lbl.textContent = sd ? 'DraftKings Showdown' : 'DraftKings MLB';
  const btn = document.getElementById('gen-three-btn');
  if (btn) btn.textContent = sd ? 'Generate 3 Showdown Lineups' : 'Generate Cash + Single + GPP';
  const bvpRow = document.getElementById('allow-bvp')?.closest('label');
  if (bvpRow) bvpRow.style.display = sd ? 'none' : '';
  const contestSel = document.getElementById('contest-type-sel');
  if (contestSel) contestSel.style.display = sd ? 'none' : '';

  // Portfolio builder — hide classic-only settings in showdown mode
  document.querySelectorAll('.port-classic-only').forEach(el => {
    el.style.display = sd ? 'none' : '';
  });
  const lockban = document.getElementById('port-lockban-section');
  if (lockban) lockban.style.display = sd ? 'none' : '';
  const descClassic = document.getElementById('port-desc-classic');
  const descShowdown = document.getElementById('port-desc-showdown');
  if (descClassic) descClassic.style.display = sd ? 'none' : '';
  if (descShowdown) descShowdown.style.display = sd ? '' : 'none';

  // Player pool position buttons — hide in showdown (no positions apply)
  const luPosBtns = document.getElementById('lu-pos-btns');
  if (luPosBtns) luPosBtns.style.display = sd ? 'none' : '';
}

function setFileStatus(type, fname, count, warnMode) {
  const dotClass = warnMode ? 'warn' : 'ok';
  document.getElementById('fd-' + type).className = 'fdot ' + dotClass;
  document.getElementById('fi-' + type).className = 'fi ' + (warnMode ? 'warn' : 'ok');
  const fn = document.getElementById('fn-' + type);
  fn.textContent = fname; fn.className = 'fn ' + dotClass;
  document.getElementById('fc-' + type).textContent = count;
}

let activeWarnings = {};
function showUploadWarn(key, fname, fields, extra) {
  let msg = '';
  if (key === 'unknown') {
    const fieldList = (fields || []).slice(0, 15).join(', ');
    msg = `<strong>Could not detect file type:</strong> ${esc(fname)}<br>Headers: <code style="font-size:11px">${esc(fieldList)}</code>`;
  } else if (key === 'mismatch') {
    const severity = extra.matchPct < 50 ? 'Likely wrong slate —' : 'Partial mismatch —';
    msg = `<strong>Slate mismatch:</strong> ${severity} only ${extra.matched} of ${extra.total} ROO players (${extra.matchPct}%) matched to DK salaries. Players without projections will score 0. Make sure both files are from the same slate date.`;
  }
  activeWarnings[key] = msg;
  renderWarnings();
}
function hideUploadWarn(key) { delete activeWarnings[key]; renderWarnings(); }

// Fix #1 — Ownership sanity banner in the Player Pool tab. Lists players whose uploaded
// ownership deviates sharply from the internal model estimate (likely stale data), since
// every leverage/field/simROI number is downstream of these inputs. Hidden when clean.
function renderOwnershipBanner() {
  const el = document.getElementById('ownership-flag-banner');
  if (!el) return;
  const flags = STATE.ownershipFlags || [];
  if (!flags.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
  const show = flags.slice(0, 8);
  const chips = show.map(f => {
    const arrow = f.direction === 'higher' ? '↑' : '↓';
    const color = f.direction === 'higher' ? 'var(--td)' : 'var(--ti)';
    return `<span style="display:inline-block;background:var(--bp);border:0.5px solid var(--brd-s);border-radius:4px;padding:1px 6px;margin:2px 4px 0 0;font-size:11px" title="Uploaded ${f.uploadedOwn}% vs model estimate ~${f.projectedOwn}%">${esc(f.name)} <strong style="color:${color}">${f.uploadedOwn}%${arrow}</strong> <span style="color:var(--tt)">~${f.projectedOwn}%</span></span>`;
  }).join('');
  const more = flags.length > show.length ? `<span style="font-size:11px;color:var(--tt);margin-left:4px">+${flags.length - show.length} more</span>` : '';
  el.style.display = 'block';
  el.innerHTML = `<div class="ib warn" style="margin:6px 0">`
    + `<strong>Ownership sanity check:</strong> ${flags.length} player${flags.length > 1 ? 's' : ''} deviate sharply from the model estimate — verify these uploaded numbers aren't stale before trusting leverage and sim ROI.`
    + `<div style="margin-top:4px">${chips}${more}</div>`
    + `</div>`;
}

function renderWarnings() {
  const el = document.getElementById('upload-warnings');
  const keys = Object.keys(activeWarnings);
  if (!keys.length) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.innerHTML = keys.map(k => `<div class="ib warn" style="margin-bottom:8px">${activeWarnings[k]}</div>`).join('');
}

function checkAllLoaded() {
  const rooCount = STATE.ROO_SOURCES.filter(Boolean).length;
  const hasPlayers = STATE.DK_PLAYERS.length > 0 || STATE.ROO.length > 0;
  const hasStacks = STATE.STACKS3.length > 0 || STATE.STACKS5.length > 0;
  if (!hasPlayers && !hasStacks) return;
  document.getElementById('upload-status').style.display = 'block';
  const poolSize = STATE.POOL.length || STATE.ROO.length;
  const withExternal = STATE.POOL.filter(p => p.hasRoo && p.median > 0).length;
  const withInternal = STATE.POOL.filter(p => p.hasInternalProj && !p.hasRoo && p.median > 0).length;
  const withProj = STATE.POOL.filter(p => p.median > 0).length || STATE.ROO.length;
  let projLabel;
  if (rooCount > 1) projLabel = rooCount + ' sources blended';
  else if (STATE.MODE === 'dk' && withInternal > 0 && withExternal > 0) projLabel = `${withExternal} ROO + ${withInternal} internal`;
  else if (withInternal > 0 && withExternal === 0) projLabel = 'internal model';
  else projLabel = STATE.MODE === 'dk' ? 'matched to ROO' : 'from ROO';
  document.getElementById('upload-metrics').innerHTML = [
    { l: 'Players', v: poolSize, s: STATE.MODE === 'dk' ? 'on DK slate' : 'in ROO' },
    { l: 'With projections', v: withProj, s: projLabel },
    { l: '3-man stacks', v: STATE.STACKS3.length, s: STATE.STACKS3.length ? 'loaded' : 'not loaded' },
    { l: '5-man stacks', v: STATE.STACKS5.length, s: STATE.STACKS5.length ? 'loaded' : 'not loaded' },
    { l: 'Optimal lineups', v: STATE.OPTIMAL_LINEUPS.length, s: STATE.OPTIMAL_LINEUPS.length ? 'loaded' : 'not loaded' }
  ].map(m => `<div class="mc"><div class="mc-l">${m.l}</div><div class="mc-v">${m.v}</div><div class="mc-s">${m.s}</div></div>`).join('');
  const hasTeamScoring = Object.keys(STATE.TEAM_SCORING).length > 0;
  const hasOptimal = STATE.OPTIMAL_LINEUPS.length > 0;
  const count = [hasPlayers, STATE.STACKS3.length > 0, STATE.STACKS5.length > 0, hasTeamScoring, hasOptimal].filter(Boolean).length;
  document.getElementById('slate-badge').textContent = count + '/5 files loaded';
  document.getElementById('slate-badge').className = 'pill ' + (count >= 5 ? 'psu' : 'pw');
  populateQsTeamSel();
}

// ── Player Pool Rendering ─────────────────────────────────────────────────────
function setPos(p, btn) { STATE.curPos = p; STATE.playerLimit = 80; document.querySelectorAll('#pos-btns .pb').forEach(b => b.classList.remove('active')); btn.classList.add('active'); renderPlayers(); }
function setLuPos(p, btn) { STATE.luPos = p; document.querySelectorAll('#lu-pos-btns .pb').forEach(b => b.classList.remove('active')); btn.classList.add('active'); renderLuPool(); }
function setSortCol(c) { if (STATE.sortCol === c) STATE.sortDir *= -1; else { STATE.sortCol = c; STATE.sortDir = -1; } renderPlayers(); }
function showMorePlayers() { STATE.playerLimit += DISPLAY_LIMIT; renderPlayers(); }

function filterPlayers() {
  const tf = (_EL['team-sel'] || document.getElementById('team-sel'))?.value;
  const gf = (_EL['game-sel'] || document.getElementById('game-sel'))?.value;
  const q = ((_EL['search-inp'] || document.getElementById('search-inp'))?.value || '').toLowerCase().trim();
  const filterConfirmed = (_EL['filter-confirmed'] || document.getElementById('filter-confirmed'))?.checked;
  const filterHideInjured = (_EL['filter-hide-injured'] || document.getElementById('filter-hide-injured'))?.checked;
  return STATE.POOL.filter(p =>
    posMatchFilter(p, STATE.curPos) &&
    (!tf || tf === 'ALL' || p.team === tf) &&
    (!gf || gf === 'ALL' || !p.game || p.game === gf) &&
    (!q || p.name.toLowerCase().includes(q)) &&
    (!filterConfirmed || p.isConfirmed) &&
    (!filterHideInjured || p.injuryType !== 'IL')
  );
}

function sortPlayers(data, sc) {
  data.sort((a, b) => {
    if (sc === 'name') return STATE.sortDir * (a.name.localeCompare(b.name));
    if (sc === 'value') return STATE.sortDir * ((b.median / b.salary || 0) - (a.median / a.salary || 0));
    if (sc === 'avgppg') return STATE.sortDir * (b.avgPpg - a.avgPpg);
    if (sc === 'gppScore') return STATE.sortDir * ((Engine.calcGppScore(b, STATE.contestSize)) - (Engine.calcGppScore(a, STATE.contestSize)));
    return STATE.sortDir * ((b[sc] || 0) - (a[sc] || 0));
  });
  return data;
}

// multContext is identical for every row in a render pass, so renderPlayers builds
// it once and threads it through. (Previously each row re-allocated this object
// literal — N allocations per render for no benefit.)
function buildMultContext() {
  return {
    vegasData: STATE.vegasData, parkFactors: STATE.parkFactors,
    weatherData: STATE.weatherData, stadiums: STATE.stadiumData,
    teamScoring: STATE.TEAM_SCORING, blendWeights: STATE.blendWeights,
    bullpenData: STATE.bullpenData, framingMap: STATE.framingMap,
    sprintSpeedData: STATE.sprintSpeedData
  };
}

function renderPlayerRow(p, idx, maxC, usedNames, multContext) {
  const bw = Math.round(p.ceiling / maxC * 55);
  const lc = p.lev > 5 ? 'lp' : p.lev < -2 ? 'ln' : 'lz';
  const inLu = usedNames.has(p.name);
  const gppS = Engine.calcGppScore(p, STATE.contestSize);

  // Multiplier deviation badge: warn when compound adjustments push the player
  // more than 25% away from their raw projection. This usually means multiple
  // factors (park + Vegas + weather + Statcast) are all stacking in the same
  // direction — which may double-count factors already in the projection CSV.
  let multBadge = '';
  try {
    const em = Engine.computeEffectiveMult(p, multContext);
    if (em.isOver) {
      const pct = (em.deviation * 100).toFixed(0);
      const sign = em.deviation > 0 ? '+' : '';
      const color = em.deviation > 0 ? 'var(--tw)' : 'var(--td)';
      multBadge = `<span class="pill" style="font-size:9px;margin-left:3px;background:var(--bw);color:${color}" title="Compound adjustments push this player ${sign}${pct}% from raw projection — check for double-counting if your CSV already prices in park/Vegas">\u26a0\ufe0f adj${sign}${pct}%</span>`;
    }
  } catch (e) { /* context incomplete — skip badge */ }
  // Opt% = how often this player lands in the optimal lineup. Source is either an uploaded
  // optimizer export or the sim-derived computeOptimalExposure run (see "Optimal %" button).
  // When sim-derived, append a true-leverage chip (optimal% \u2212 ownership%): green = under-owned
  // relative to optimal (a GPP play), red = over-owned chalk (a fade).
  const optExpTitle = p.optExpSource === 'sim'
    ? 'Sim-derived optimal lineup % (Monte Carlo). Chip = true leverage = optimal% \u2212 ownership%.'
    : 'Optimal exposure from uploaded optimizer export';
  const trueLevPill = (p.optExpSource === 'sim' && p.trueLev != null)
    ? ` <span class="pill ${p.trueLev > 0 ? 'psu' : 'pd'}" style="font-size:9px" title="True leverage = optimal% \u2212 ownership%">${p.trueLev > 0 ? '+' : ''}${p.trueLev.toFixed(0)}</span>`
    : '';
  const optExpVal = p.optExp > 0 ? `<span class="pill ${p.optExp > 30 ? 'psu' : p.optExp > 10 ? 'pi' : 'pg'}" title="${optExpTitle}">${p.optExp.toFixed(1)}%</span>${trueLevPill}` : '\u2014';
  const confirmedBadge = p.isConfirmed ? `<span class="pill psu" style="font-size:9px;margin-left:3px">${p.confirmedOrder ? '#' + p.confirmedOrder : 'SP'}</span>` : '';
  const scBadge = p.barrelRate > 0 ? `<span class="pill ${p.barrelRate >= 10 ? 'psu' : p.barrelRate >= 7 ? 'pi' : 'pg'}" style="font-size:9px;margin-left:3px">Brl:${p.barrelRate.toFixed(0)}%</span>` : '';
  const injuryBadge = p.dkStatus === 'O'
    ? `<span class="pill pd" style="font-size:9px;margin-left:3px" title="DK: Out">OUT</span>`
    : p.injuryFlag ? `<span class="pill ${p.injuryType === 'IL' ? 'pd' : 'pw'}" style="font-size:9px;margin-left:3px" title="${escAttr(p.injuryDesc || '')}">${p.injuryType || 'INJ'}</span>` : '';
  const postponedBadge = p.isPostponed ? `<span class="pill pd" style="font-size:9px;margin-left:3px" title="Game postponed/cancelled">PPD</span>` : '';
  const formColor = p.recentAvgDK && p.median > 0 ? (p.recentAvgDK / p.median >= 1.2 ? 'var(--tsu)' : p.recentAvgDK / p.median <= 0.8 ? 'var(--td)' : '') : '';
  const kDisplay = rp(p, 'P') && p.kRate > 0 ? `<span style="font-size:11px;color:${p.kRate > 25 ? 'var(--tsu)' : p.kRate > 20 ? 'var(--ti)' : 'var(--ts)'}">${p.kRate.toFixed(0)}%</span>` : '\u2014';
  let dvpBadge = '';
  if (p.opp && Object.keys(STATE.dvpData).length) {
    const dvpPos = rp(p, 'P') ? 'P' : p.dkPos ? p.dkPos.split('/')[0].trim() : null;
    const dvpEntry = dvpPos && STATE.dvpData[p.opp]?.[dvpPos];
    if (dvpEntry?.rank && dvpEntry?.totalTeams) {
      const pct = dvpEntry.rank / dvpEntry.totalTeams;
      const dvpClass = pct <= 0.25 ? 'psu' : pct >= 0.75 ? 'pd' : 'pi';
      const dvpLabel = pct <= 0.25 ? 'easy' : pct >= 0.75 ? 'tough' : 'mid';
      // #14: Surface sample size — early-season DVP can be noisy at < 15 games.
      // Show sample as a small suffix; dim styling when sample is thin (<15 games)
      // so users discount the signal appropriately.
      const games = dvpEntry.games || 0;
      const sampleStr = games > 0 ? ` N=${games}` : '';
      const thin = games > 0 && games < 15;
      const sampleStyle = thin ? 'opacity:.55;font-style:italic' : '';
      dvpBadge = `<span class="pill ${dvpClass}" style="font-size:9px;margin-left:3px;${sampleStyle}" title="vs ${p.opp} ${dvpPos} rank ${dvpEntry.rank}/${dvpEntry.totalTeams} (${dvpEntry.avgAllowed} DK avg allowed${games > 0 ? ', sample ' + games + ' games' + (thin ? ' — small sample, discount this signal' : '') : ''})">DvP:${dvpLabel}${sampleStr}</span>`;
    }
  }
  // Ownership input cues (Fix #1): mark modeled estimates (no uploaded value) with a
  // dashed border + "est" tag, and flag uploaded numbers that deviate from the model with
  // a \u26a0. Both are non-blocking visual hints; the cell stays editable to override.
  const ownFlagged = STATE.ownershipFlagNames && STATE.ownershipFlagNames.has(p.name.toLowerCase());
  const ownEst = p.ownProjected === true;
  const ownBorder = ownFlagged ? '1px solid var(--tw)' : ownEst ? '1px dashed var(--ti)' : '0.5px solid var(--brd-s)';
  const ownTitle = ownFlagged ? 'Uploaded ownership deviates sharply from the model estimate \u2014 verify it is not stale' : ownEst ? 'Modeled ownership estimate (no uploaded value) \u2014 edit to override' : 'Edit projected ownership %';
  const ownMark = ownFlagged ? ' <span style="font-size:10px;color:var(--tw)" title="deviates from model estimate">\u26a0</span>' : ownEst ? ' <span style="font-size:8px;color:var(--ti);vertical-align:super" title="modeled estimate">est</span>' : '';
  const projBadge = STATE.MODE === 'dk' && !p.hasRoo
    ? (p.hasInternalProj
        ? '<span style="font-size:9px;background:#1a3a1a;color:#5dba5d;border-radius:3px;padding:1px 4px;margin-left:4px" title="Projection built from season rate stats (no ROO CSV)">internal</span>'
        : '<span style="font-size:10px;background:var(--bw);color:var(--tw);border-radius:3px;padding:1px 4px;margin-left:4px">no proj</span>')
    : '';
  return `<tr style="${inLu ? 'opacity:.38;' : ''}"><td><strong style="${formColor ? 'color:' + formColor : ''}">${esc(p.name)}</strong>${projBadge}${confirmedBadge}${scBadge}${injuryBadge}${postponedBadge}${dvpBadge}${multBadge}</td><td><span class="pill pi" style="font-size:10px">${esc(p.dkPos) || '\u2014'}</span></td><td>${esc(p.team)}</td><td>${p.salary > 0 ? '$' + p.salary.toLocaleString() : '\u2014'}</td><td>${p.order > 0 ? '#' + p.order : '\u2014'}</td><td>${p.floor > 0 ? p.floor.toFixed(1) : '\u2014'}</td><td>${p.median > 0 ? '<strong>' + p.median.toFixed(1) + '</strong>' : '\u2014'}</td><td>${p.ceiling > 0 ? `<div class="bar-w"><div class="bar" style="width:${bw}px"></div><span style="font-size:11px;color:var(--ts)">${p.ceiling.toFixed(1)}</span></div>` : '\u2014'}</td><td style="white-space:nowrap"><input type="number" min="0" max="100" step="0.5" value="${p.own > 0 ? p.own.toFixed(1) : ''}" placeholder="0" title="${ownTitle}" style="width:50px;font-size:11px;padding:2px 4px;border:${ownBorder};border-radius:4px;background:var(--bp);color:${p.own > 50 ? 'var(--td)' : p.own > 25 ? 'var(--tw)' : p.own > 10 ? 'var(--ti)' : 'var(--tp)'};text-align:center" oninput="updatePlayerOwn(${idx},this.value)">${ownMark}</td><td class="${lc}">${p.lev !== 0 ? (p.lev > 0 ? '+' : '') + p.lev.toFixed(1) : '\u2014'}</td><td style="color:var(--ti);font-weight:500">${gppS > 0 ? gppS.toFixed(1) : '\u2014'}</td><td>${optExpVal}</td><td>${p.avgPpg > 0 ? p.avgPpg.toFixed(1) : '\u2014'}</td><td>${kDisplay}</td><td style="white-space:nowrap"><button class="btn" style="padding:3px 6px;font-size:11px;margin-right:3px${STATE.projOverrides[p.name] ? ';border-color:var(--tsu);color:var(--tsu)' : ''}" onclick="openOverrideModal('${escAttr(p.name)}')" title="Override projection values">✎</button><button class="btn" style="padding:3px 8px;font-size:11px" ${inLu ? 'disabled' : ''} onclick="addPlayerByPoolIdx(${idx})">+</button></td></tr>`;
}

// Filter/sort result cache — avoids O(n log n) resort on every render when filters haven't changed
let _playerRenderCache = null;
function invalidatePlayerRenderCache() { _playerRenderCache = null; }

function renderPlayers() {
  if (!STATE.POOL.length) return;
  const sf = (_EL['sort-sel'] || document.getElementById('sort-sel'))?.value || '';
  const sc = sf || STATE.sortCol;
  const tf = (_EL['team-sel'] || document.getElementById('team-sel'))?.value || 'ALL';
  const gf = (_EL['game-sel'] || document.getElementById('game-sel'))?.value || 'ALL';
  const q  = (_EL['search-inp'] || document.getElementById('search-inp'))?.value || '';
  const fc = (_EL['filter-confirmed'] || document.getElementById('filter-confirmed'))?.checked || false;
  const fh = (_EL['filter-hide-injured'] || document.getElementById('filter-hide-injured'))?.checked || false;
  const cacheKey = `${STATE.POOL.length}|${STATE.curPos}|${sc}|${tf}|${gf}|${q}|${fc}|${fh}|${STATE.playerLimit}`;

  let data;
  if (_playerRenderCache && _playerRenderCache.key === cacheKey) {
    data = _playerRenderCache.data;
  } else {
    data = sortPlayers(filterPlayers(), sc);
    _playerRenderCache = { key: cacheKey, data };
  }

  const maxC = data.reduce((m, p) => Math.max(m, p.ceiling || 0), 1);
  const usedNames = new Set(STATE.lineup.filter(Boolean).map(p => p.name));
  const displayData = data.slice(0, STATE.playerLimit);
  STATE._playerPoolCache = displayData;
  const multContext = buildMultContext(); // built once, shared across all rows
  const tbody = _EL['player-tbody'] || document.getElementById('player-tbody');
  if (tbody) tbody.innerHTML = displayData.map((p, idx) => renderPlayerRow(p, idx, maxC, usedNames, multContext)).join('');
  const moreEl = _EL['player-more'] || document.getElementById('player-more');
  if (moreEl) moreEl.style.display = data.length > STATE.playerLimit ? 'block' : 'none';
  const countEl = _EL['player-count'] || document.getElementById('player-count');
  if (countEl) {
    const showing = Math.min(data.length, STATE.playerLimit);
    countEl.textContent = data.length === STATE.POOL.length ? `${data.length} players` : `Showing ${showing} of ${data.length} (${STATE.POOL.length} total)`;
  }
}

// ── Sim-derived Optimal % + true leverage (Feature #2) ────────────────────────
// Runs Engine.computeOptimalExposure over the current pool and annotates each player with
// p.optExp (optimal lineup %) and p.trueLev (optimal% − ownership%). Feeds the same "Opt%"
// column that the uploaded optimizer export uses — but generated locally, so you get the
// game-theory leverage signal the paid tools sell without needing an external file.
async function computeOptimalPct() {
  if (!STATE.POOL.length) { showToast('Load a player pool first.', 'warn'); return; }
  const btn = document.getElementById('btn-opt-pct');
  const prev = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Computing…'; }
  // Yield so the button label repaints before the synchronous compute blocks the thread.
  await new Promise(r => setTimeout(r, 0));
  try {
    const allowBvP = document.getElementById('allow-bvp')?.checked || false;
    const res = Engine.computeOptimalExposure(STATE.POOL, { numDraws: 400, allowBvP });
    let n = 0;
    STATE.POOL.forEach(p => {
      const r = res[p.name];
      if (r) { p.optExp = r.optimalPct; p.optExpSource = 'sim'; p.trueLev = r.trueLeverage; n++; }
    });
    invalidatePlayerRenderCache();
    renderPlayers();
    showToast(`Optimal % computed over 400 sims for ${n} players. Sort by "True Leverage" to surface under-owned plays.`, 'success', 4000);
  } catch (e) {
    showToast('Optimal % computation failed: ' + (e.message || e), 'warn');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = prev || 'Optimal %'; }
  }
}

// ── Stacks Rendering ──────────────────────────────────────────────────────────
function renderStacks() {
  const allStacks = [...STATE.STACKS3, ...STATE.STACKS5];
  if (!allStacks.length) return;
  // Normalize both sides through the alias table before comparing — so an in-memory
  // stack loaded with an old code (e.g. OAK from a pre-rebrand CSV) still matches a
  // DK pool using the current code (ATH). Without normalization on the pool side,
  // a partial alias rollout left orphan codes flagged as off-slate.
  const poolTeams = new Set(STATE.POOL.map(p => normalizeTeamAbbr(p.team)));
  const stackTeams = [...new Set(allStacks.map(s => normalizeTeamAbbr(s.team)))];
  const offSlate = stackTeams.filter(t => poolTeams.size > 0 && !poolTeams.has(t));
  const warnEl = document.getElementById('stacks-slate-warn');
  if (offSlate.length > 0 && STATE.POOL.length > 0) {
    warnEl.style.display = 'block'; warnEl.className = 'ib warn';
    warnEl.innerHTML = `<strong>Off-slate teams:</strong> ${esc(offSlate.join(', '))}`;
  } else { warnEl.style.display = 'none'; }

  const tf = document.getElementById('stack-team-sel').value;
  const typeF = document.getElementById('stack-type-sel').value;
  const sf = document.getElementById('stack-sort-sel').value;
  const poolNames = new Set(STATE.POOL.map(p => p.name.toLowerCase()));
  const sortFn = (a, b) => sf === 'salary' ? a.salary - b.salary : sf === 'own' ? a.own - b.own : sf === 'optPrimary' ? (b.optPrimary || 0) - (a.optPrimary || 0) : b.proj - a.proj;

  function renderGroup(stacks, label, badgeClass) {
    if (!stacks.length) return '';
    let data = [...stacks];
    if (tf !== 'ALL') data = data.filter(s => s.team === tf);
    data.sort(sortFn);
    if (!data.length) return '';
    return `<div class="stack-type-hdr"><span class="stb ${badgeClass}">${esc(label)}</span><span style="font-size:12px;color:var(--tt)">${data.length} stacks</span></div>` + data.slice(0, 20).map((s, vi) => {
      const allOnSlate = s.players.every(p => !poolNames.size || poolNames.has(p.toLowerCase()));
      const optInfo = s.optPrimary != null ? `<div>Opt: <strong>${s.optPrimary.toFixed(1)}%</strong> pri${s.optSecondary > 0 ? ' / ' + s.optSecondary.toFixed(1) + '% sec' : ''}</div>` : '';
      return `<div class="sk-card"><div class="sk-hdr"><div style="display:flex;align-items:center;gap:8px"><span style="font-size:14px;font-weight:500">#${vi + 1}</span><span class="pill pi">${esc(s.team)}</span><span style="font-size:12px;color:var(--ts)">${s.players.length}-man</span>${!allOnSlate && poolNames.size ? '<span style="font-size:10px;background:var(--bw);color:var(--tw);border-radius:3px;padding:1px 5px">off slate</span>' : ''}</div><div style="font-size:18px;font-weight:500;color:var(--tsu)">${s.proj.toFixed(1)}</div></div><div class="chips">${s.players.map((p, pi) => {
        const onSlate = !poolNames.size || poolNames.has(p.toLowerCase());
        return `<span class="chip${onSlate ? '' : ' off-slate'}" ${onSlate ? `onclick="addStackPlayer('${s.id}',${pi})"` : ''}>${esc(p)}</span>`;
      }).join('')}</div><div class="sk-meta"><div>Salary: <strong>$${s.salary.toLocaleString()}</strong></div><div>Own: <strong>${s.own.toFixed(1)}%</strong></div>${optInfo}<button class="btn" style="padding:3px 8px;font-size:11px" onclick="useStackById('${s.id}')">Use</button></div></div>`;
    }).join('');
  }
  let html = '';
  if (typeF === 'ALL' || typeF === '3') html += renderGroup(STATE.STACKS3, '3-man stacks', 's3');
  if (typeF === 'ALL' || typeF === '5') html += renderGroup(STATE.STACKS5, '5-man stacks', 's5');
  document.getElementById('stacks-container').innerHTML = html || '<div class="empty" style="padding:20px">No stacks match filters.</div>';
}

// ── Lineup Builder ────────────────────────────────────────────────────────────
function getSalaryUsed() { return STATE.lineup.reduce((s, p) => s + (p ? p.salary : 0), 0); }
function isShowdown() { return STATE.slateType === 'showdown'; }

function renderLineup() {
  const slots = activeSlots();
  const cap = activeSalaryCap();
  const sd = isShowdown();

  // Pre-compute BvP conflicts (classic only — showdown typically includes cross-game matchups)
  const allowBvP = sd || document.getElementById('allow-bvp')?.checked || false;
  const bvpConflicts = new Set();
  if (!allowBvP) {
    STATE.lineup.forEach(p => {
      if (p && rp(p, 'P') && p.opp) bvpConflicts.add(p.opp);
    });
  }

  document.getElementById('lineup-slots').innerHTML = slots.map((slot, i) => {
    const p = STATE.lineup[i];
    const isCptSlot = sd && slot.key === 'CPT';
    if (!p) {
      const cptHint = isCptSlot ? '<span style="font-size:10px;color:var(--ti);margin-left:6px">1.5× pts</span>' : '';
      return `<div class="lu-slot${isCptSlot ? ' lu-slot-cpt' : ''}"><div class="slot-pos"${isCptSlot ? ' style="color:var(--ti)"' : ''}>${slot.label}</div><div class="slot-empty">Empty${cptHint}</div></div>`;
    }
    const ownDisplay = p.own > 0 ? ` \u00B7 ${p.own.toFixed(1)}% own` : '';
    const isBvP = !allowBvP && !rp(p, 'P') && bvpConflicts.has(p.team);
    const isLocked = STATE.lockedSlots?.[i] || false;
    const slotClass = `lu-slot filled${isBvP ? ' lu-slot-bvp' : ''}${isCptSlot ? ' lu-slot-cpt' : ''}${isLocked ? ' lu-slot-locked' : ''}`;
    const bvpBadge = isBvP ? `<span style="font-size:10px;font-weight:600;color:var(--td);margin-left:6px" title="Batter vs. Pitcher conflict">BvP</span>` : '';
    const cptBadge = isCptSlot ? `<span style="font-size:10px;font-weight:700;color:var(--ti);margin-left:6px" title="Captain — scores 1.5× points">CPT 1.5×</span>` : '';
    const lockBadge = isLocked ? `<span style="font-size:10px;font-weight:600;color:#f59e0b;margin-left:6px">LOCKED</span>` : '';
    const posLabel = sd ? '' : (esc(p.dkPos || p.rosterPos) + ' · ');
    const slotInlineStyle = isBvP ? 'border-color:var(--brd-d);background:var(--bd)' : isLocked ? 'border-color:#f59e0b;background:rgba(245,158,11,.07)' : '';
    const lockBtn = `<button class="slot-lock${isLocked ? ' locked' : ''}" onclick="toggleLock(${i})" title="${isLocked ? 'Unlock player' : 'Lock player in place'}">&#x1F512;</button>`;
    return `<div class="${slotClass}"${slotInlineStyle ? ` style="${slotInlineStyle}"` : ''}><div class="slot-pos" style="${isCptSlot ? 'color:var(--ti);font-weight:700' : isBvP ? 'color:var(--td)' : isLocked ? 'color:#f59e0b' : ''}">${slot.label}</div><div style="flex:1"><div class="slot-name">${esc(p.name)}${cptBadge}${bvpBadge}${lockBadge}</div><div class="slot-info">${posLabel}${esc(p.team)}${p.opp ? ' vs ' + esc(p.opp) : ''} · $${p.salary.toLocaleString()}${ownDisplay}</div></div>${lockBtn}<button class="slot-rm" onclick="removeFromLineup(${i})">x</button></div>`;
  }).join('');
  const used = getSalaryUsed(), rem = cap - used, pct = Math.min(used / cap * 100, 100);
  document.getElementById('sal-used').textContent = '$' + used.toLocaleString();
  const re = document.getElementById('sal-remain');
  re.textContent = rem >= 0 ? '$' + rem.toLocaleString() + ' left' : 'OVER by $' + Math.abs(rem).toLocaleString();
  re.style.color = rem < 0 ? 'var(--td)' : rem < 3000 ? 'var(--tw)' : 'var(--tsu)';
  document.getElementById('sal-bar').style.width = pct + '%';
  document.getElementById('sal-bar').className = 'sal-bar' + (rem < 0 ? ' over' : rem < 5000 ? ' warn' : '');

  const playersInLineup = STATE.lineup.filter(Boolean);
  const totalMedian = playersInLineup.reduce((sum, p) => sum + (p.median || 0), 0);
  const avgOwnership = playersInLineup.length > 0
    ? playersInLineup.reduce((sum, p) => sum + (p.own || 0), 0) / playersInLineup.length
    : 0;
  document.getElementById('median-total').textContent = totalMedian.toFixed(1);
  document.getElementById('own-avg').textContent = avgOwnership.toFixed(1);

  const rosterSz = activeRosterSize();
  const warns = [];
  if (rem < 0) warns.push(`Over $${cap.toLocaleString()} salary cap`);
  const filled = playersInLineup.length;
  if (filled > 0 && filled < rosterSz) warns.push(`${rosterSz - filled} slot${rosterSz - filled > 1 ? 's' : ''} empty`);
  if (bvpConflicts.size > 0) {
    const bvpPlayers = playersInLineup.filter(p => !rp(p, 'P') && bvpConflicts.has(p.team)).map(p => p.name);
    if (bvpPlayers.length) warns.push(`BvP conflict: ${bvpPlayers.join(', ')} face your pitcher — toggle "Allow BvP" to permit`);
  }
  const wEl = document.getElementById('lineup-warns');
  wEl.style.display = warns.length ? 'block' : 'none';
  if (warns.length) { wEl.className = 'ib warn'; wEl.innerHTML = warns.map(w => w).join('<br>'); }

  // Live lineup analysis: correlation, stacks, calibration disclosure
  const analysisEl = document.getElementById('lineup-analysis');
  if (analysisEl && playersInLineup.length >= 4) {
    const analysis = Engine.analyzeLineup(STATE.lineup);
    if (analysis) {
      const corrColor = analysis.correlationScore >= 0.6 ? 'var(--tsu)' : analysis.correlationScore >= 0.35 ? 'var(--ti)' : 'var(--td)';
      const stackBadges = analysis.stacks.map(s =>
        `<span class="pill psu" style="font-size:10px">${esc(s.team)} ${s.count}-stack</span>`
      ).join(' ');

      // Raw (uncalibrated) median — reverse the active calibration scales so users
      // can compare this number against external optimizer projections.
      const cal = Engine.getCalibration();
      const batScale = cal.batterScale || 1.0;
      const pitScale = cal.pitcherScale || 1.0;
      const hasCalibration = Math.abs(batScale - 1.0) > 0.01 || Math.abs(pitScale - 1.0) > 0.01;
      let calBadge = '';
      if (hasCalibration) {
        const rawMedian = playersInLineup.reduce((s, p) => {
          const scale = rp(p, 'P') ? pitScale : batScale;
          return s + (scale > 0 ? (p.median || 0) / scale : (p.median || 0));
        }, 0);
        calBadge = `<span title="Calibration active: batters ×${batScale.toFixed(3)}, pitchers ×${pitScale.toFixed(3)}. Raw ROO projection = ${rawMedian.toFixed(1)} pts." ` +
          `style="background:var(--bw);color:var(--tw);padding:2px 7px;border-radius:4px;font-size:10px;font-weight:600;cursor:help">` +
          `Cal ×${batScale.toFixed(2)} · Raw ${rawMedian.toFixed(0)}</span>`;
      }

      analysisEl.style.display = 'block';
      analysisEl.innerHTML = `<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:11px">
        <span>Corr: <strong style="color:${corrColor}">${analysis.correlationScore.toFixed(2)}</strong></span>
        <span>Ceil: <strong>${analysis.ceilingPts.toFixed(1)}</strong></span>
        <span>Floor: <strong>${analysis.floorPts.toFixed(1)}</strong></span>
        <span>Val: <strong>${analysis.salaryEfficiency}</strong>x</span>
        ${stackBadges}
        ${calBadge}
      </div>`;
    }
  } else if (analysisEl) {
    analysisEl.style.display = 'none';
  }

  // Best Plays guidance panel
  renderBestPlaysGuidance();
  checkPositionScarcity();
}

function renderBestPlaysGuidance() {
  const el = document.getElementById('best-plays-guidance');
  if (!el || !STATE.lastBestPlays) return;

  const ctx = STATE.bestPlaysContext;
  const plays = STATE.lastBestPlays;
  const lineup = STATE.lineup.filter(Boolean);
  const lineupNames = new Set(lineup.map(p => p.name));

  // Count plays in current lineup
  const leverageCount = lineup.filter(p => ctx.leveragePlays.has(p.name)).length;
  const chalkCount = lineup.filter(p => ctx.chalkPlayers.has(p.name)).length;
  const contrarianCount = lineup.filter(p => ctx.contrarianPlayers.has(p.name)).length;
  const bringBackCount = lineup.filter(p => ctx.bringBackPlayers.has(p.name)).length;

  // Identify missing recommendations
  const missingLeverage = plays.gpp.leveragePlays.filter(e => !lineupNames.has(e.p.name)).slice(0, 3);
  const missingContrarian = plays.gpp.contrarianStack?.top5.filter(e => !lineupNames.has(e.p.name)).slice(0, 2) || [];

  let html = '<div style="display:flex;gap:12px;flex-wrap:wrap;font-size:11px">';

  // Leverage count
  const leverageStyle = leverageCount >= 2 ? 'var(--tsu)' : leverageCount === 1 ? 'var(--ti)' : 'var(--ts)';
  html += `<div style="flex:1;min-width:150px;padding:8px;background:var(--bs);border-radius:var(--r);border-left:3px solid ${leverageStyle}">`;
  html += `<div style="color:var(--ts);margin-bottom:2px">⚡ Leverage Plays</div>`;
  html += `<div style="font-weight:700;color:${leverageStyle};margin-bottom:4px">${leverageCount} in lineup</div>`;
  if (missingLeverage.length > 0) {
    html += `<div style="font-size:10px;color:var(--tt);margin-top:4px">${missingLeverage.length} available:<br>`;
    html += missingLeverage.map(e => `<div onclick="addToLineupByName('${escAttr(e.p.name)}')" style="cursor:pointer;color:var(--ti);text-decoration:underline;padding:1px 0">${esc(e.p.name)}</div>`).join('');
    html += '</div>';
  }
  html += '</div>';

  // Chalk count
  const chalkStyle = chalkCount === 0 ? 'var(--tsu)' : chalkCount <= 1 ? 'var(--ti)' : 'var(--tw)';
  html += `<div style="flex:1;min-width:150px;padding:8px;background:var(--bs);border-radius:var(--r);border-left:3px solid ${chalkStyle}">`;
  html += `<div style="color:var(--ts);margin-bottom:2px">⚠️ Chalk Alert</div>`;
  html += `<div style="font-weight:700;color:${chalkStyle};margin-bottom:4px">${chalkCount} in lineup</div>`;
  if (chalkCount > 1) {
    html += `<div style="font-size:10px;color:var(--tw)">Consider fading chalk for GPP uniqueness</div>`;
  } else if (chalkCount === 0) {
    html += `<div style="font-size:10px;color:var(--tsu)">Good — avoiding chalk concentration</div>`;
  }
  html += '</div>';

  // Contrarian count
  const contrarianStyle = contrarianCount >= 2 ? 'var(--tsu)' : contrarianCount === 1 ? 'var(--ti)' : 'var(--ts)';
  html += `<div style="flex:1;min-width:150px;padding:8px;background:var(--bs);border-radius:var(--r);border-left:3px solid ${contrarianStyle}">`;
  html += `<div style="color:var(--ts);margin-bottom:2px">🎯 Contrarian Stack</div>`;
  html += `<div style="font-weight:700;color:${contrarianStyle};margin-bottom:4px">${contrarianCount}/${plays.gpp.contrarianStack?.top5.length || 0}</div>`;
  if (plays.gpp.contrarianStack && missingContrarian.length > 0) {
    html += `<div style="font-size:10px;color:var(--ti);margin-top:4px">Add <strong>${esc(plays.gpp.contrarianStack.team)}</strong>:<br>`;
    html += missingContrarian.map(e => `<div onclick="addToLineupByName('${escAttr(e.p.name)}')" style="cursor:pointer;color:var(--ti);text-decoration:underline;padding:1px 0">${esc(e.p.name)}</div>`).join('');
    html += '</div>';
  }
  html += '</div>';

  // Bring-back count
  if (plays.gpp.bringBack) {
    const bbStyle = bringBackCount >= 1 ? 'var(--tsu)' : 'var(--ts)';
    html += `<div style="flex:1;min-width:150px;padding:8px;background:var(--bs);border-radius:var(--r);border-left:3px solid ${bbStyle}">`;
    html += `<div style="color:var(--ts);margin-bottom:2px">↩️ Bring-Back (${esc(plays.gpp.bringBack.team)})</div>`;
    html += `<div style="font-weight:700;color:${bbStyle};margin-bottom:4px">${bringBackCount} in lineup</div>`;
    if (bringBackCount === 0 && plays.gpp.bringBack.entries.length > 0) {
      html += `<div style="font-size:10px;color:var(--ti);margin-top:4px">Game correlation:<br>`;
      html += plays.gpp.bringBack.entries.slice(0, 2).map(e => `<div onclick="addToLineupByName('${escAttr(e.p.name)}')" style="cursor:pointer;color:var(--ti);text-decoration:underline;padding:1px 0">${esc(e.p.name)}</div>`).join('');
      html += '</div>';
    }
    html += '</div>';
  }

  html += '</div>';
  el.innerHTML = html;
  el.style.display = 'block';
}

function renderLuPool() {
  if (!STATE.POOL.length) return;
  const usedNames = new Set(STATE.lineup.filter(Boolean).map(p => p.name));
  const sd = isShowdown();
  STATE._luPoolCache = STATE.POOL.filter(p => posMatchFilter(p, STATE.luPos)).sort((a, b) => b.median - a.median || b.avgPpg - a.avgPpg).slice(0, 100);
  document.getElementById('lu-pool-tbody').innerHTML = STATE._luPoolCache.map((p, idx) => {
    const inLu = usedNames.has(p.name);
    const posCell = sd
      ? (p.isCpt ? '<span style="font-size:10px;font-weight:700;color:#60a5fa">CPT</span>' : '<span style="font-size:10px;color:var(--tt)">FLEX</span>')
      : (esc(p.dkPos) || '\u2014');
    const medDisplay = sd && p.isCpt
      ? `<span style="color:#60a5fa">${p.median > 0 ? p.median.toFixed(1) : '\u2014'}</span>`
      : (p.median > 0 ? p.median.toFixed(1) : '\u2014');
    return `<tr style="${inLu ? 'opacity:.35;' : ''}"><td>${esc(p.name)}</td><td style="color:var(--tt);font-size:11px">${posCell}</td><td>${esc(p.team)}</td><td>$${p.salary.toLocaleString()}</td><td>${medDisplay}</td><td>${p.own > 0 ? p.own.toFixed(1) + '%' : '\u2014'}</td><td><button class="btn" style="padding:2px 7px;font-size:11px" ${inLu ? 'disabled' : ''} onclick="addPlayerByLuIdx(${idx})">+</button></td></tr>`;
  }).join('');
}

function addToLineupByName(name) { const p = STATE.POOL.find(r => r.name === name); if (p) addToLineup(p); }
function addToLineup(p) {
  if (!p) return;
  // In showdown, block adding same underlying player twice (CPT + FLEX of same person)
  if (STATE.lineup.some(lp => lp && lp.name === p.name)) return;
  const slots = activeSlots();
  const cap = activeSalaryCap();
  for (let i = 0; i < slots.length; i++) {
    if (STATE.lineup[i]) continue;
    if (!slots[i].eligible(p)) continue;
    if (getSalaryUsed() + p.salary > cap) {
      const over = getSalaryUsed() + p.salary - cap;
      showToast(`Cannot add ${esc(p.name)} — would exceed cap by $${over.toLocaleString()}`, 'warn', 3000);
      return;
    }
    STATE.lineup[i] = p; renderLineup(); renderLuPool(); saveSession(); return;
  }
}
function useStackById(id) {
  const s = [...STATE.STACKS3, ...STATE.STACKS5].find(st => st.id === id);
  if (!s) return;
  s.players.forEach(name => { const p = STATE.POOL.find(r => r.name === name); if (p) addToLineup(p); });
  showTab('lineup');
}
function removeFromLineup(i) {
  if (STATE.lockedSlots?.[i]) {
    showToast('Unlock this player first before removing them', 'warn', 3000);
    return;
  }
  const removed = STATE.lineup[i];
  STATE.lineup[i] = null;
  renderLineup(); renderLuPool(); saveSession();
  if (removed) {
    showToast(`Removed ${esc(removed.name)}`, 'info', 3000, () => {
      STATE.lineup[i] = removed; renderLineup(); renderLuPool(); saveSession();
    });
  }
}
function clearLineup() {
  STATE.lineup = new Array(activeRosterSize()).fill(null);
  STATE.lockedSlots = new Array(activeRosterSize()).fill(false);
  const optEl = document.getElementById('optimal-status');
  if (optEl) optEl.style.display = 'none';
  renderLineup(); renderLuPool(); document.getElementById('export-out').style.display = 'none'; saveSession();
}
function toggleLock(i) {
  if (!STATE.lineup[i]) return;
  if (!STATE.lockedSlots) STATE.lockedSlots = new Array(activeRosterSize()).fill(false);
  STATE.lockedSlots[i] = !STATE.lockedSlots[i];
  renderLineup();
  saveSession();
}

// ── Quick Stack ───────────────────────────────────────────────────────────────
function setQsSize(size, btn) {
  STATE.quickStackSize = size;
  document.querySelectorAll('#qs-size-btns .pb').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  updateQsPreview();
}

function populateQsTeamSel() {
  const sel = document.getElementById('qs-team-sel');
  if (!sel) return;
  const batters = STATE.POOL.filter(p => !rp(p, 'P') && p.salary > 0);
  const teams = [...new Set(batters.map(p => p.team))];
  teams.sort((a, b) => ((STATE.vegasData?.[b]?.impliedTotal ?? 0) - (STATE.vegasData?.[a]?.impliedTotal ?? 0)));
  const cur = sel.value;
  sel.innerHTML = '<option value="auto">Auto (Best Team)</option>' +
    teams.map(t => {
      const it = STATE.vegasData?.[t]?.impliedTotal;
      const label = it != null ? `${t}  ·  ${it.toFixed(1)} impl` : t;
      return `<option value="${t}"${t === cur ? ' selected' : ''}>${label}</option>`;
    }).join('');
  updateQsPreview();
}

function resolveQsTeam() {
  const val = document.getElementById('qs-team-sel')?.value || 'auto';
  if (val !== 'auto') return val;
  const size = STATE.quickStackSize || 4;
  const batters = STATE.POOL.filter(p => !rp(p, 'P') && p.salary > 0 && (p.median > 0 || p.avgPpg > 0));
  const teams = [...new Set(batters.map(p => p.team))];
  teams.sort((a, b) => ((STATE.vegasData?.[b]?.impliedTotal ?? 0) - (STATE.vegasData?.[a]?.impliedTotal ?? 0)));
  return teams.find(t => batters.filter(p => p.team === t).length >= size) || teams[0] || null;
}

function updateQsPreview() {
  const el = document.getElementById('qs-preview');
  if (!el || !STATE.POOL.length) { if (el) el.style.display = 'none'; return; }
  const team = resolveQsTeam();
  if (!team) { el.style.display = 'none'; return; }
  const size = STATE.quickStackSize || 4;
  const stack = Engine.buildVirtualStack(team, STATE.POOL, new Set(), size, STATE.vegasData || {});
  if (!stack) { el.style.display = 'none'; return; }
  const it = STATE.vegasData?.[team]?.impliedTotal;
  const itStr = it != null ? ` · ${it.toFixed(1)} impl` : '';
  let bbStr = '';
  if (document.getElementById('qs-bringback')?.checked) {
    const opp = STATE.POOL.find(p => p.team === team && !rp(p, 'P'))?.opp;
    if (opp) {
      const bbPlayer = STATE.POOL
        .filter(p => p.team === opp && !rp(p, 'P') && p.salary > 0 && p.order >= 1 && p.order <= 7)
        .sort((a, b) => ((b.ceiling || b.median || 0) - (a.ceiling || a.median || 0)))[0];
      if (bbPlayer) {
        const oit = STATE.vegasData?.[opp]?.impliedTotal;
        bbStr = ` <span style="color:var(--ts)">+ ${esc(bbPlayer.name)} <em>(${opp}${oit != null ? ' ' + oit.toFixed(1) : ''} BB)</em></span>`;
      }
    }
  }
  el.style.display = 'block';
  el.innerHTML = `<strong style="color:var(--ti)">${team} ${size}-stack${itStr}:</strong> ${stack.players.map(n => `<strong>${esc(n)}</strong>`).join(' · ')}${bbStr}`;
}

function applyQuickStack() {
  if (!STATE.POOL.length) return;
  const team = resolveQsTeam();
  if (!team) { showToast('No eligible team found — load player pool first', 'warn', 3000); return; }
  const size = STATE.quickStackSize || 4;
  const stack = Engine.buildVirtualStack(team, STATE.POOL, new Set(), size, STATE.vegasData || {});
  if (!stack || stack.players.length < size) {
    showToast(`Not enough ${team} batters for a ${size}-man stack`, 'warn', 3000);
    return;
  }
  // Clear batter slots; preserve pitchers and locked players
  activeSlots().forEach((slot, i) => {
    if (STATE.lineup[i] && !rp(STATE.lineup[i], 'P') && !STATE.lockedSlots?.[i]) STATE.lineup[i] = null;
  });
  stack.players.forEach(name => {
    const p = STATE.POOL.find(r => r.name === name);
    if (p) addToLineup(p);
  });
  // Bring-back: best batter (by ceiling) from opposing team, batting order 1-7
  let bbAdded = null;
  if (document.getElementById('qs-bringback')?.checked) {
    const opp = STATE.POOL.find(p => p.team === team && !rp(p, 'P'))?.opp;
    if (opp) {
      const inLineup = new Set(STATE.lineup.filter(Boolean).map(p => p.name));
      const bbPlayer = STATE.POOL
        .filter(p => p.team === opp && !rp(p, 'P') && p.salary > 0 && p.order >= 1 && p.order <= 7 && !inLineup.has(p.name))
        .sort((a, b) => ((b.ceiling || b.median || 0) - (a.ceiling || a.median || 0)))[0];
      if (bbPlayer) { addToLineup(bbPlayer); bbAdded = bbPlayer; }
    }
  }
  const bbNote = bbAdded ? ` + ${esc(bbAdded.name)} (BB)` : '';
  showToast(`${team} ${size}-stack applied${bbNote}`, 'success', 3000);
  const statusEl = document.getElementById('qs-status');
  if (statusEl) {
    statusEl.style.display = 'block';
    statusEl.innerHTML = `Stack locked in. <a href="#" onclick="event.preventDefault();showTab('simulator');setTimeout(runSimulation,150)" style="color:var(--ti);text-decoration:underline">Run sim →</a>`;
  }
}

function clearQuickStack() {
  activeSlots().forEach((slot, i) => {
    if (STATE.lineup[i] && !rp(STATE.lineup[i], 'P') && !STATE.lockedSlots?.[i]) STATE.lineup[i] = null;
  });
  const statusEl = document.getElementById('qs-status');
  if (statusEl) statusEl.style.display = 'none';
  renderLineup(); renderLuPool(); saveSession();
}

// ── Auto-fill / Generate Lineups (using Engine) ──────────────────────────────
function autoFill() {
  const sz = activeRosterSize();
  if (!STATE.lockedSlots || STATE.lockedSlots.length !== sz) STATE.lockedSlots = new Array(sz).fill(false);

  // Clear only unlocked slots — locked players stay put
  for (let i = 0; i < sz; i++) {
    if (!STATE.lockedSlots[i]) STATE.lineup[i] = null;
  }

  const ctx = getEngineContext();
  const pool = getCalibratedPool();
  const contestType = document.getElementById('contest-type-sel')?.value || 'single';
  const allowBvP = document.getElementById('allow-bvp')?.checked || false;
  const btn = document.getElementById('autofill-btn');
  const optEl = document.getElementById('optimal-status');
  if (optEl) optEl.style.display = 'none';

  if (isShowdown()) {
    const sdScoreFn = p => contestType === 'cash'
      ? Engine.scoreCash(p, { ...ctx, pool })
      : Engine.scoreGpp(p, { ...ctx, pool });
    STATE.lineup = Engine.optimizeShowdownLineup(pool, sdScoreFn) || new Array(SHOWDOWN_ROSTER_SIZE).fill(null);
    renderLineup(); renderLuPool(); saveSession();
    return;
  }

  // Classic: exact branch-and-bound optimal solver, building around locked players
  const requiredSlots = STATE.lineup.map((p, i) => (STATE.lockedSlots[i] ? p : null));
  if (btn) { btn.textContent = 'Solving…'; btn.disabled = true; }
  let scoreFn;
  if (contestType === 'cash') scoreFn = p => Engine.scoreCash(p, ctx);
  else if (contestType === 'gpp') scoreFn = p => Engine.scoreGpp(p, ctx);
  else scoreFn = p => Engine.scoreSingle(p, ctx);

  setTimeout(() => {
    try {
      const result = Engine.solveOptimal(pool, scoreFn, { allowBvP, requiredSlots });
      STATE.lineup = result.lineup || new Array(ROSTER_SIZE).fill(null);
      renderLineup(); renderLuPool(); saveSession();
      showOptimalStatus(result, contestType);
    } catch (err) {
      console.error('Optimal solver error:', err);
      const stackBonusFn = contestType === 'gpp' ? lu => Engine.gppStackBonus(lu, null) : null;
      STATE.lineup = Engine.optimizeLineup(pool, scoreFn, { iterations: OPTIMIZER_ITERATIONS, stackBonusFn, allowBvP, contestType }) || new Array(ROSTER_SIZE).fill(null);
      renderLineup(); renderLuPool(); saveSession();
    } finally {
      if (btn) { btn.textContent = 'Auto-fill'; btn.disabled = false; }
    }
  }, 50);
}

function showOptimalStatus(result, contestType) {
  const el = document.getElementById('optimal-status');
  if (!el) return;
  const badge = result.optimal
    ? `<span style="background:rgba(34,197,94,.15);color:#22c55e;border:0.5px solid rgba(34,197,94,.3);padding:2px 8px;border-radius:4px;font-weight:700;font-size:11px">Provably Optimal ✓</span>`
    : `<span style="background:var(--bw);color:var(--tw);border:0.5px solid var(--brd-w);padding:2px 8px;border-radius:4px;font-weight:700;font-size:11px">Best Found</span>`;
  const score = result.score != null ? `<strong>${result.score.toFixed(1)}</strong> pts` : '';
  const gap = result.warmScore != null && result.score != null && result.score > result.warmScore
    ? `<span style="color:#22c55e">+${(result.score - result.warmScore).toFixed(1)} vs greedy</span>` : '';
  const stats = `<span style="color:var(--ts)">${result.nodesExplored.toLocaleString()} nodes · ${result.solveMs}ms</span>`;
  const note = contestType === 'gpp' ? `<span style="color:var(--ts)" title="Stack bonus is non-linear and applied as a projection boost per player. The exact solver maximizes projected score.">proj-optimal</span>` : '';
  el.style.display = 'flex';
  el.innerHTML = [badge, score, gap, stats, note].filter(Boolean).join(' · ');
}

function generateThreeLineups() {
  if (!STATE.POOL.length) return;
  if (isShowdown()) { generateShowdownLineups(); return; }
  STATE.generatedLineups = [];
  const ctx = getEngineContext();
  const pool = getCalibratedPool();
  const allowBvP = document.getElementById('allow-bvp')?.checked || false;

  const cashLu = Engine.generateCashLineup(pool, new Set(), ctx, OPTIMIZER_ITERATIONS, allowBvP);
  STATE.generatedLineups.push(cashLu);

  const cashNames = new Set(cashLu.filter(Boolean).map(p => p.name));
  const cashExclude = new Set();
  const shuffled1 = [...cashNames]; for (let i = shuffled1.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shuffled1[i], shuffled1[j]] = [shuffled1[j], shuffled1[i]]; }
  shuffled1.slice(0, Math.floor(shuffled1.length * 0.4)).forEach(nm => cashExclude.add(nm));
  const singleLu = Engine.generateSingleLineup(pool, cashExclude, ctx, OPTIMIZER_ITERATIONS, allowBvP);
  STATE.generatedLineups.push(singleLu);

  const allUsed = new Set([...cashNames, ...singleLu.filter(Boolean).map(p => p.name)]);
  const gppExclude = new Set();
  const shuffled2 = [...allUsed]; for (let i = shuffled2.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shuffled2[i], shuffled2[j]] = [shuffled2[j], shuffled2[i]]; }
  shuffled2.slice(0, Math.floor(shuffled2.length * 0.5)).forEach(nm => gppExclude.add(nm));
  const usedStackIds = new Set();
  const gppLu = Engine.generateGppLineup(pool, gppExclude, ctx, STATE.STACKS3, STATE.STACKS5, usedStackIds, OPTIMIZER_ITERATIONS, STATE.contestSize, null, null, allowBvP);
  STATE.generatedLineups.push(gppLu);

  displayThreeLineups();
}

function generateShowdownLineups() {
  STATE.generatedLineups = [];
  const ctx = getEngineContext();
  const pool = getCalibratedPool();
  // Generate 3 showdown lineups with increasing jitter for diversity
  for (let v = 0; v < 3; v++) {
    const jitter = v * 0.4;
    const exclude = new Set(v > 0 ? (STATE.generatedLineups[v - 1] || []).filter(Boolean).map(p => p.name).slice(0, 2) : []);
    const sdContest = document.getElementById('contest-type-sel')?.value || 'single';
    const scoreFn = p => (sdContest === 'cash' ? Engine.scoreCash(p, { ...ctx, pool }) : Engine.scoreGpp(p, { ...ctx, pool })) + (Math.random() - 0.5) * jitter;
    const lu = Engine.optimizeShowdownLineup(pool, scoreFn, { excludeNames: exclude });
    STATE.generatedLineups.push(lu || new Array(SHOWDOWN_ROSTER_SIZE).fill(null));
  }
  displayThreeLineups();
}

function generateLineupsFromBestPlays() {
  if (!STATE.POOL.length) return;
  if (!STATE.lastBestPlays) {
    showToast('Load Best Plays first (click Best Plays tab)', 'warn', 3000);
    return;
  }
  if (isShowdown()) {
    showToast('Best Plays lineups not yet supported for Showdown', 'warn', 3000);
    return;
  }

  STATE.generatedLineups = [];
  const ctx = getEngineContext();
  const pool = getCalibratedPool();
  const allowBvP = document.getElementById('allow-bvp')?.checked || false;
  const plays = STATE.lastBestPlays;
  dlog('[BestPlays lineups] pool=%d allowBvP=%s', pool.length, allowBvP);
  dlog('[BestPlays lineups] SE pitcher=%s seStack=%s contrarian=%s',
    plays.singleEntry.pitchers[0]?.p.name || 'NONE',
    plays.singleEntry.stack?.team || 'NONE',
    plays.gpp.contrarianStack?.team || 'NONE');

  // Helper: seed optimizer with specific players
  function seedOptimizer(seedNames, scoreFn, excludeNames = new Set()) {
    const missing = seedNames.filter(n => !STATE.POOL.find(p => p.name === n));
    if (missing.length) dlog('[BestPlays lineups] seedOptimizer: missing from POOL: %s', missing.join(', '));
    const seedPlayers = seedNames
      .map(name => pool.find(p => p.name === name))
      .filter(p => p && !excludeNames.has(p.name));
    // Names in seedNames that are in STATE.POOL but filtered out by calibration (benched/scratched)
    const notCalibrated = seedNames.filter(n => !missing.includes(n) && !seedPlayers.some(p => p.name === n));
    if (notCalibrated.length) dlog('[BestPlays lineups] seedOptimizer: not in calibrated pool (benched/scratched?): %s', notCalibrated.join(', '));
    const exclude = new Set([...excludeNames, ...missing, ...notCalibrated]);
    const usable = pool.filter(p => !exclude.has(p.name));
    if (seedPlayers.length < 2) {
      console.warn('[BestPlays lineups] seedOptimizer: only %d seed players (need ≥2) — lineup skipped. seeds=%s', seedPlayers.length, seedNames.join(', '));
      return null;
    }
    return Engine.optimizeLineup([...seedPlayers, ...usable], scoreFn, {
      iterations: OPTIMIZER_ITERATIONS,
      allowBvP,
      forceInclude: new Set(seedPlayers.map(p => p.name))
    });
  }

  // Lineup 1: CASH — Chalk SP + Best stack + Value plays
  const cashSeedNames = [
    plays.singleEntry.pitchers[0]?.p.name,
    ...plays.singleEntry.stack?.entries.map(e => e.p.name) || [],
    ...plays.singleEntry.valuePlays.slice(0, 2).map(e => e.p.name) || []
  ].filter(Boolean);
  dlog('[BestPlays lineups] Lineup 1 (CASH) seeds: %s', cashSeedNames.join(', '));
  const cashLu = seedOptimizer(cashSeedNames, p => Engine.scoreCash(p, ctx));
  if (!cashLu) console.warn('[BestPlays lineups] Lineup 1 (CASH) failed — null result from optimizer');
  STATE.generatedLineups.push(cashLu || null);

  // Lineup 2: SINGLE — Recommended SP + Stack + Leverage
  const singleSeedNames = [
    plays.singleEntry.pitchers[0]?.p.name,
    ...plays.singleEntry.stack?.entries.map(e => e.p.name) || [],
    plays.gpp.leveragePlays[0]?.p.name,
  ].filter(Boolean);
  dlog('[BestPlays lineups] Lineup 2 (SINGLE) seeds: %s', singleSeedNames.join(', '));
  const singleLu = seedOptimizer(singleSeedNames, p => Engine.scoreSingle(p, ctx));
  if (!singleLu) console.warn('[BestPlays lineups] Lineup 2 (SINGLE) failed — null result from optimizer');
  STATE.generatedLineups.push(singleLu || null);

  // Lineup 3: GPP CONTRARIAN — Contrarian 5-man + Bring-back + Leverage plays
  const contrarianSeedNames = [
    ...plays.gpp.contrarianStack?.top5.map(e => e.p.name) || [],
    ...plays.gpp.bringBack?.entries.slice(0, 2).map(e => e.p.name) || [],
    plays.gpp.leveragePlays[0]?.p.name,
    plays.gpp.leveragePlays[1]?.p.name,
  ].filter(Boolean);
  dlog('[BestPlays lineups] Lineup 3 (CONTRARIAN) seeds: %s', contrarianSeedNames.join(', '));
  const contrarianLu = seedOptimizer(contrarianSeedNames, p => Engine.scoreGpp(p, ctx));
  if (!contrarianLu) console.warn('[BestPlays lineups] Lineup 3 (CONTRARIAN) failed — null result from optimizer');
  STATE.generatedLineups.push(contrarianLu || null);

  // Lineup 4: LEVERAGE STACK — All ceiling/own ratio plays
  const leverageSeedNames = plays.gpp.leveragePlays.slice(0, 4).map(e => e.p.name).filter(Boolean);
  dlog('[BestPlays lineups] Lineup 4 (LEVERAGE) seeds: %s', leverageSeedNames.join(', '));
  const leverageLu = seedOptimizer(leverageSeedNames, p => Engine.scoreGpp(p, ctx));
  if (!leverageLu) console.warn('[BestPlays lineups] Lineup 4 (LEVERAGE) failed — null result from optimizer');
  STATE.generatedLineups.push(leverageLu || null);

  // Lineup 5: VALUE + BOOM — Value at middle positions + Boom/bust candidates
  const valueSeedNames = [
    ...plays.singleEntry.valuePlays.slice(0, 3).map(e => e.p.name),
    ...plays.gpp.boomBust.slice(0, 2).map(e => e.p.name),
  ].filter(Boolean);
  dlog('[BestPlays lineups] Lineup 5 (VALUE/BOOM) seeds: %s', valueSeedNames.join(', '));
  const valueLu = seedOptimizer(valueSeedNames, p => Engine.scoreSingle(p, ctx));
  if (!valueLu) console.warn('[BestPlays lineups] Lineup 5 (VALUE/BOOM) failed — null result from optimizer');
  STATE.generatedLineups.push(valueLu || null);

  displayBestPlaysLineups();
}

function displayBestPlaysLineups() {
  const slots = activeSlots();
  const rosterSz = activeRosterSize();
  const plays = STATE.lastBestPlays;
  const types = [
    { name: 'CASH STACK', idx: 0, strategy: 'Chalk SP + Best Stack + Value plays', emoji: '💰' },
    { name: 'SINGLE ENTRY', idx: 1, strategy: 'SE Stack + Leverage plays', emoji: '⚖️' },
    { name: 'GPP CONTRARIAN', idx: 2, strategy: 'Contrarian 5-man + Bring-back + Leverage', emoji: '🎯' },
    { name: 'LEVERAGE STACK', idx: 3, strategy: 'High ceiling/own ratio plays (GPP)', emoji: '⚡' },
    { name: 'VALUE + BOOM', idx: 4, strategy: 'Value base + Boom/bust upside', emoji: '💡' },
  ];
  const html = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px">${types.map(type => {
    const lu = STATE.generatedLineups[type.idx];
    if (!lu) return `<div style="border:0.5px dashed var(--brd-t);border-radius:var(--rl);padding:12px;background:var(--bp);text-align:center;color:var(--ts)">Could not generate ${type.name} lineup</div>`;
    const filled = lu.filter(Boolean);
    const mediaScore = filled.reduce((s, p) => s + (p.median || 0), 0);
    const ceilScore = filled.reduce((s, p) => s + (p.ceiling || 0), 0);
    const salUsed = filled.reduce((s, p) => s + p.salary, 0);
    const avgOwn = filled.length > 0 ? filled.reduce((s, p) => s + (p.own || 0), 0) / filled.length : 0;
    const analysis = Engine.analyzeLineup(lu);
    const stackInfo = analysis ? analysis.stacks.map(s => s.team + ' x' + s.count).join(', ') : '';

    return `<div style="border:0.5px solid var(--brd-t);border-radius:var(--rl);padding:12px;background:var(--bp)">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:10px;padding-bottom:8px;border-bottom:0.5px solid var(--brd-s)">
        <div style="font-size:16px">${type.emoji}</div>
        <div style="flex:1"><div style="font-size:13px;font-weight:600;color:var(--tp)">${type.name}</div><div style="font-size:10px;color:var(--ts);margin-top:2px">${type.strategy}</div></div>
      </div>
      <div style="margin-bottom:8px;max-height:280px;overflow-y:auto">${lu.map((p, i) => {
        const slotLabel = slots[i]?.label || '?';
        if (!p) return `<div style="padding:4px 6px;font-size:11px;color:var(--ts);background:var(--bs);border-radius:4px;margin-bottom:3px">${slotLabel}: EMPTY</div>`;
        const isLeverage = STATE.bestPlaysContext.leveragePlays.has(p.name);
        const isChalk = STATE.bestPlaysContext.chalkPlayers.has(p.name);
        const isContrarian = STATE.bestPlaysContext.contrarianPlayers.has(p.name);
        const tags = (isLeverage ? '⚡' : '') + (isChalk ? '⚠️' : '') + (isContrarian ? '🎯' : '');
        return `<div style="padding:4px 6px;font-size:11px;background:${isContrarian ? 'rgba(34,197,94,.08)' : isLeverage ? 'rgba(34,197,94,.08)' : isChalk ? 'rgba(239,68,68,.08)' : 'var(--bs)'};border-radius:4px;margin-bottom:3px">${tags ? '<span style="margin-right:3px">' + tags + '</span>' : ''}<strong>${esc(p.name)}</strong> (${esc(p.dkPos)}) $${p.salary.toLocaleString()} <span style="color:var(--ts)">${p.median.toFixed(1)}pts ${p.own > 0 ? p.own.toFixed(1) + '%' : ''}</span></div>`;
      }).join('')}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:8px;background:var(--bs);border-radius:var(--r);font-size:10px">
        <div>Salary: <strong>$${salUsed.toLocaleString()}</strong></div>
        <div>Median: <strong>${mediaScore.toFixed(1)}</strong></div>
        <div>Ceiling: <strong>${ceilScore.toFixed(1)}</strong></div>
        <div>Own: <strong>${avgOwn.toFixed(1)}%</strong></div>
      </div>
      ${stackInfo ? `<div style="margin-top:6px;padding:4px 8px;background:var(--bi);border-radius:4px;font-size:10px;color:var(--ti)">Stack: ${stackInfo}</div>` : ''}
      ${analysis ? `<div style="margin-top:4px;font-size:10px;color:var(--tt)">Corr: ${analysis.correlationScore.toFixed(3)}</div>` : ''}
      <button class="btn-p" onclick="STATE.lineup = [...STATE.generatedLineups[${type.idx}]]; renderLineup(); renderLuPool(); showToast('Loaded ${esc(type.name)} lineup', 'info', 2000);" style="width:100%;margin-top:8px;font-size:11px">Load This Lineup</button>
    </div>`;
  }).join('')}</div>`;
  document.getElementById('best-plays-lineups-display').innerHTML = html;
  document.getElementById('best-plays-lineups-display').style.display = 'block';
}

function displayThreeLineups() {
  const sd = isShowdown();
  const slots = activeSlots();
  const rosterSz = activeRosterSize();
  const types = sd
    ? [
        { name: 'SHOWDOWN #1', lineup: STATE.generatedLineups[0], strategy: 'Top Projected / Ceiling Chase' },
        { name: 'SHOWDOWN #2', lineup: STATE.generatedLineups[1], strategy: 'Contrarian Captain / Low Own' },
        { name: 'SHOWDOWN #3', lineup: STATE.generatedLineups[2], strategy: 'Value / Balanced Ownership' }
      ]
    : [
        { name: 'CASH', lineup: STATE.generatedLineups[0], strategy: 'High Floor / Batting Order / Pitcher Matchups' },
        { name: 'SINGLE ENTRY', lineup: STATE.generatedLineups[1], strategy: 'Balanced Upside / Salary Value / Optimal Median' },
        { name: 'GPP', lineup: STATE.generatedLineups[2], strategy: 'Ceiling Chase / Stacking / Low Own' }
      ];
  const html = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px">${types.map(type => {
    const lu = type.lineup || new Array(rosterSz).fill(null);
    const filled = lu.filter(Boolean);
    const mediaScore = filled.reduce((s, p) => s + (p.median || 0), 0);
    const ceilScore = filled.reduce((s, p) => s + (p.ceiling || 0), 0);
    const salUsed = filled.reduce((s, p) => s + p.salary, 0);
    const avgOwn = filled.length > 0 ? filled.reduce((s, p) => s + (p.own || 0), 0) / filled.length : 0;
    const analysis = Engine.analyzeLineup(lu);
    const stackInfo = analysis ? analysis.stacks.map(s => s.team + ' x' + s.count).join(', ') : '';

    return `<div style="border:0.5px solid var(--brd-t);border-radius:var(--rl);padding:12px;background:var(--bp)">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;padding-bottom:8px;border-bottom:0.5px solid var(--brd-s)">
        <div style="flex:1"><div style="font-size:13px;font-weight:500;color:var(--tp)">${type.name}</div><div style="font-size:10px;color:var(--ts)">${type.strategy}</div></div>
      </div>
      <div style="margin-bottom:8px">${lu.map((p, i) => {
        const slotLabel = slots[i]?.label || '?';
        const isCpt = sd && slotLabel === 'CPT';
        if (!p) return `<div style="padding:4px 6px;font-size:11px;color:var(--ts);background:var(--bs);border-radius:4px;margin-bottom:3px">${slotLabel}: EMPTY</div>`;
        const posInfo = sd ? '' : `(${esc(p.dkPos)}) `;
        const cptTag = isCpt ? `<span style="font-size:9px;font-weight:700;color:var(--ti);background:rgba(59,130,246,.15);padding:1px 4px;border-radius:3px;margin-right:3px">CPT</span>` : '';
        return `<div style="padding:4px 6px;font-size:11px;background:${isCpt ? 'rgba(59,130,246,.1)' : 'var(--bsu)'};border-radius:4px;margin-bottom:3px">${cptTag}<strong>${esc(p.name)}</strong> ${posInfo}${p.order > 0 && p.order <= 4 && !sd ? '<span style="font-size:9px;background:var(--bw);color:var(--tw);padding:1px 3px;border-radius:3px">#' + p.order + '</span> ' : ''}$${p.salary.toLocaleString()} ${p.median.toFixed(1)}pts ${p.own > 0 ? p.own.toFixed(1) + '%' : ''}</div>`;
      }).join('')}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:8px;background:var(--bs);border-radius:var(--r);font-size:11px">
        <div>Salary: <strong>$${salUsed.toLocaleString()}</strong></div>
        <div>Median: <strong>${mediaScore.toFixed(1)}</strong></div>
        <div>Ceiling: <strong>${ceilScore.toFixed(1)}</strong></div>
        <div>Own: <strong>${avgOwn.toFixed(1)}%</strong></div>
      </div>
      ${!sd && stackInfo ? `<div style="margin-top:6px;padding:4px 8px;background:var(--bi);border-radius:4px;font-size:10px;color:var(--ti)">Stack: ${stackInfo}</div>` : ''}
      ${analysis ? `<div style="margin-top:4px;font-size:10px;color:var(--tt)">Corr: ${analysis.correlationScore.toFixed(3)} / Eff: ${analysis.salaryEfficiency} pts/$k</div>` : ''}
    </div>`;
  }).join('')}</div>`;
  document.getElementById('three-lineups-display').innerHTML = html;
  document.getElementById('three-lineups-display').style.display = 'block';
  STATE.lineup = [...STATE.generatedLineups[0]];
  renderLineup(); renderLuPool();
}

// ── Export ─────────────────────────────────────────────────────────────────────
// Properly quote a single CSV field — wraps in double-quotes and escapes internal quotes
function csvQuote(v) {
  const s = String(v == null ? '' : v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function exportLineup() {
  if (!STATE.lineup.filter(Boolean).length) return;
  const slots = activeSlots();
  const rows = [['Slot', 'Player', 'Pos', 'Team', 'Salary', 'Median']];
  STATE.lineup.forEach((p, i) => {
    const label = slots[i]?.label || '?';
    rows.push(p ? [label, p.name, p.dkPos || '', p.team, '$' + p.salary, p.median > 0 ? p.median.toFixed(1) : ''] : [label, 'EMPTY', '', '', '', '']);
  });
  dlFile(rows.map(r => r.map(csvQuote).join(',')).join('\n'), 'lineups.csv', 'text/csv');
}
function exportDK() {
  const rosterSz = activeRosterSize();
  const cap = activeSalaryCap();
  const slots = activeSlots();
  if (!STATE.lineup.every(Boolean)) {
    alert(`Lineup has empty slots. Fill all ${rosterSz} positions before exporting.`);
    return;
  }
  const salary = STATE.lineup.reduce((s, p) => s + (p?.salary || 0), 0);
  if (salary > cap) {
    alert(`Lineup is over the $${cap.toLocaleString()} salary cap ($${salary.toLocaleString()}). Please adjust before exporting.`);
    return;
  }
  const missing = STATE.lineup.filter(p => !p.dkId);
  if (missing.length) {
    alert('Missing DK IDs for: ' + missing.map(p => p.name).join(', ') + '\nUpload your DK Salaries CSV first.');
    return;
  }
  // Warn on injured, unconfirmed, or postponed players before upload
  const exportWarnings = [];
  STATE.lineup.forEach(p => {
    if (!p) return;
    if (p.dkStatus === 'O') exportWarnings.push(`${p.name}: Listed OUT by DraftKings`);
    else if (p.injuryType === 'IL') exportWarnings.push(`${p.name}: On Injured List`);
    else if (p.injuryFlag) exportWarnings.push(`${p.name}: ${p.injuryDesc || p.injuryType || 'Injury flag'}`);
    if (!rp(p, 'P') && p.isConfirmed === false) exportWarnings.push(`${p.name}: Lineup not yet confirmed`);
    if (p.isPostponed) exportWarnings.push(`${p.name}: Game postponed/cancelled`);
  });
  if (exportWarnings.length && !confirm('Export warning — review before uploading to DraftKings:\n\n' + exportWarnings.map(w => '• ' + w).join('\n') + '\n\nExport anyway?')) return;
  const header = slots.map(s => s.label).join(',');
  const row = STATE.lineup.map(p => p.dkId).join(',');
  dlFile(header + '\n' + row, 'dk_upload.csv', 'text/csv');
}
function dlFile(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ═══════════════════════════════════════════════════════════════════════════════
// VEGAS & WEATHER TAB
// POST vegas data to server; retries once after 600ms on a 409 (write lock busy)
async function saveVegasToServer(data) {
  const body = JSON.stringify(data);
  const opts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body };
  const res = await fetch('/api/vegas', opts);
  if (res.status === 409) {
    await new Promise(r => setTimeout(r, 600));
    const retry = await fetch('/api/vegas', opts);
    if (!retry.ok) throw new Error(`Vegas save failed after retry: ${retry.status}`);
  } else if (!res.ok) {
    throw new Error(`Vegas save failed: ${res.status}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
async function loadVegasWeatherData() {
  try {
    const [vegasRes, parkRes, stadiumRes] = await Promise.all([
      fetch('/api/vegas').then(r => r.json()),
      fetch('/api/park-factors').then(r => r.json()),
      fetch('/api/stadiums').then(r => r.json())
    ]);
    STATE.vegasData = vegasRes && Object.keys(vegasRes).length ? vegasRes : null;
    STATE.parkFactors = parkRes;
    STATE.stadiumData = stadiumRes;
    renderVegasPanel();
    await loadWindEffects();
    renderSlateEnvironment();
  } catch (e) {
    console.error('Failed to load vegas/weather data:', e);
    // Soft toast — load failures are recoverable (user can hit Refresh), but they
    // should know the dashboard is showing stale or empty data.
    showToast('Could not load Vegas/weather/park data: ' + (e.message || e) + '. Click Refresh to retry.', 'warn', 6000);
  }
}

function renderVegasPanel() {
  const games = [...new Set(STATE.POOL.map(p => p.game).filter(Boolean))];
  const teams = [...new Set(STATE.POOL.map(p => p.team).filter(Boolean))].sort();
  const vegasEl = document.getElementById('vegas-entries');
  if (!teams.length) {
    vegasEl.innerHTML = '<div class="empty">Load player data first to enter Vegas lines.</div>';
    return;
  }

  // ── Data quality warnings ────────────────────────────────────────────────
  // Use lastFetchedAt (reset every refresh) not openAt (preserved for movement tracking).
  const STALE_MS = 2 * 60 * 60 * 1000;  // 2 hours since last fetch
  const INVALID_THRESHOLD = 1.5;         // sentinel for cancelled/postponed games
  const now = Date.now();
  const staleTeams = [], invalidTeams = [];
  if (STATE.vegasData) {
    Object.entries(STATE.vegasData).forEach(([team, d]) => {
      if (teams.includes(team)) {
        const fetchTs = d.lastFetchedAt || d.openAt;
        if (fetchTs && (now - new Date(fetchTs).getTime()) > STALE_MS) staleTeams.push(team);
        if (d.impliedTotal > 0 && d.impliedTotal < INVALID_THRESHOLD) invalidTeams.push(team);
      }
    });
  }
  const warnings = [];
  if (staleTeams.length) {
    warnings.push(`Lines for <strong>${staleTeams.join(', ')}</strong> are more than 2 hours old — refresh before generating.`);
  }
  if (invalidTeams.length) {
    warnings.push(`<strong>${invalidTeams.join(', ')}</strong> implied total below 1.5 — likely a cancelled/postponed game. Engine will treat as neutral (no adjustment).`);
  }
  const warningBanner = warnings.length
    ? `<div style="margin-bottom:10px;padding:8px 12px;background:rgba(255,180,0,0.12);border:1px solid var(--tw);border-radius:var(--r);font-size:11px;color:var(--tw)">${warnings.map(w => `<div>${w}</div>`).join('')}</div>`
    : '';

  // Build game-based entry form
  const gameTeams = {};
  games.forEach(g => {
    const [away, home] = g.split('@');
    if (away && home) gameTeams[g] = { away, home };
  });

  function moveBadge(curr, open) {
    if (open == null || curr == null) return '';
    const diff = +(curr - open).toFixed(1);
    if (Math.abs(diff) < 0.1) return `<span style="font-size:10px;color:var(--tt)">Open: ${open.toFixed(1)}</span>`;
    const up = diff > 0;
    return `<span style="font-size:10px;color:${up ? 'var(--tsu)' : 'var(--td)'}">
      ${up ? '▲' : '▼'} ${Math.abs(diff).toFixed(1)} (was ${open.toFixed(1)})
    </span>`;
  }

  let html = warningBanner + '<div style="display:grid;gap:8px">';
  if (Object.keys(gameTeams).length) {
    Object.entries(gameTeams).forEach(([game, { away, home }]) => {
      const awayData = STATE.vegasData?.[away] || {};
      const homeData = STATE.vegasData?.[home] || {};
      const pf = STATE.parkFactors?.[home] || { overall: 1.0, hr: 1.0, run: 1.0 };
      const awayMove = moveBadge(awayData.impliedTotal, awayData.openTotal);
      const homeMove = moveBadge(homeData.impliedTotal, homeData.openTotal);
      html += `<div class="sk-card">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
          <strong>${esc(away)} @ ${esc(home)}</strong>
          <span class="pill pg">PF: ${pf.overall.toFixed(2)} / HR: ${pf.hr.toFixed(2)}</span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div>
            <label style="font-size:11px;color:var(--tt);display:flex;justify-content:space-between">${esc(away)} Implied${awayMove ? ' ' + awayMove : ''}</label>
            <input type="number" step="0.1" min="0" max="15" class="vegas-input" data-team="${escAttr(away)}" data-field="impliedTotal" value="${awayData.impliedTotal || ''}" placeholder="4.5" style="width:100%;padding:5px 8px;border-radius:var(--r);border:0.5px solid var(--brd-s);background:var(--bp);color:var(--tp);font-size:12px">
          </div>
          <div>
            <label style="font-size:11px;color:var(--tt);display:flex;justify-content:space-between">${esc(home)} Implied${homeMove ? ' ' + homeMove : ''}</label>
            <input type="number" step="0.1" min="0" max="15" class="vegas-input" data-team="${escAttr(home)}" data-field="impliedTotal" value="${homeData.impliedTotal || ''}" placeholder="4.5" style="width:100%;padding:5px 8px;border-radius:var(--r);border:0.5px solid var(--brd-s);background:var(--bp);color:var(--tp);font-size:12px">
          </div>
        </div>
      </div>`;
    });
  } else {
    teams.forEach(team => {
      const teamData = STATE.vegasData?.[team] || {};
      html += `<div style="display:flex;align-items:center;gap:8px">
        <span style="width:40px;font-weight:500;font-size:12px">${esc(team)}</span>
        <input type="number" step="0.1" min="0" max="15" class="vegas-input" data-team="${escAttr(team)}" data-field="impliedTotal" value="${teamData.impliedTotal || ''}" placeholder="Impl. Total" style="width:80px;padding:5px 8px;border-radius:var(--r);border:0.5px solid var(--brd-s);background:var(--bp);color:var(--tp);font-size:12px">
      </div>`;
    });
  }
  html += '</div>';
  vegasEl.innerHTML = html;

  // Render park factors display
  renderParkFactors();
  renderWeatherDisplay();
  renderSlateEnvironment();
}

function saveVegas() {
  const data = {};
  document.querySelectorAll('.vegas-input').forEach(inp => {
    const team = inp.dataset.team;
    const field = inp.dataset.field;
    const val = parseFloat(inp.value);
    if (team && !isNaN(val)) {
      if (!data[team]) data[team] = {};
      data[team][field] = val;
      // Carry open line through manual saves so movement tracking is preserved
      const prev = STATE.vegasData?.[team] || {};
      if (field === 'impliedTotal') {
        data[team].openTotal = prev.openTotal ?? val;
        data[team].openAt = prev.openAt ?? new Date().toISOString();
      }
    }
  });
  STATE.vegasData = Object.keys(data).length ? data : null;
  saveVegasToServer(data).then(() => {
    const btn = document.getElementById('save-vegas-btn');
    btn.textContent = 'Saved!'; btn.className = 'btn-g';
    setTimeout(() => { btn.textContent = 'Save Vegas Lines'; btn.className = 'btn-p'; }, 1500);
    // Recalculate leverage with vegas data (mergePools also re-renders slate summary if tab is open)
    if (STATE.POOL.length) mergePools();
    else if (document.getElementById('panel-slate')?.classList.contains('active')) renderSlateSummary();
  }).catch(e => {
    // CRITICAL: previously silent — user saw "Save Vegas Lines" button restored but the
    // data did not persist. On reload they'd lose all manual edits without knowing.
    console.error('Save vegas failed:', e);
    showToast('Failed to save Vegas lines: ' + (e.message || e) + '. Your edits will be lost on reload.', 'warn', 8000);
    const btn = document.getElementById('save-vegas-btn');
    if (btn) { btn.textContent = 'Save Failed — Retry'; btn.className = 'btn-p'; }
  });
}

async function fetchOdds() {
  const btn = document.getElementById('fetch-odds-btn');
  const creditEl = document.getElementById('odds-credits');
  btn.textContent = 'Fetching...'; btn.disabled = true;

  try {
    const res = await fetch('/api/odds/fetch');
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Fetch failed');

    const teams = data.teams || {};
    const teamCount = Object.keys(teams).length;
    if (!teamCount) {
      btn.textContent = 'No Games Found'; btn.disabled = false;
      setTimeout(() => { btn.textContent = 'Fetch Vegas Lines'; }, 2000);
      return;
    }

    // Store as vegasData and populate inputs; preserve open lines on re-fetch
    if (!STATE.vegasData) STATE.vegasData = {};
    Object.entries(teams).forEach(([abbr, info]) => {
      const prev = STATE.vegasData[abbr] || {};
      STATE.vegasData[abbr] = {
        impliedTotal: info.impliedTotal,
        openTotal: prev.openTotal ?? info.impliedTotal,
        openAt: prev.openAt ?? new Date().toISOString()
      };
    });

    // Populate input fields if the panel is rendered
    document.querySelectorAll('.vegas-input[data-field="impliedTotal"]').forEach(inp => {
      const team = inp.dataset.team;
      if (teams[team]) inp.value = teams[team].impliedTotal;
    });

    // Auto-save to server
    saveVegasToServer(STATE.vegasData);

    // Recalculate pool with new vegas data
    if (STATE.POOL.length) mergePools();

    // Show credit usage
    if (data.creditsRemaining != null) {
      creditEl.style.display = 'inline';
      creditEl.textContent = `${data.gameCount} games · ${data.creditsRemaining} API credits left`;
    }

    btn.textContent = 'Lines Loaded!'; btn.className = 'btn-g';
    setTimeout(() => { btn.textContent = 'Refresh Vegas Lines'; btn.className = 'btn-dk'; btn.disabled = false; }, 2000);
  } catch (e) {
    console.error('Odds fetch failed:', e);
    btn.textContent = 'Fetch Failed';
    btn.disabled = false;
    document.getElementById('vegas-entries').insertAdjacentHTML('afterbegin',
      `<div class="ib warn" style="margin-bottom:8px">Failed to fetch odds: ${esc(e.message)}</div>`);
    setTimeout(() => { btn.textContent = 'Fetch Vegas Lines'; }, 2000);
  }
}

function renderParkFactors() {
  const el = document.getElementById('park-factors-display');
  if (!STATE.parkFactors) { el.innerHTML = '<div class="empty">Loading park factors...</div>'; return; }
  const teams = Object.keys(STATE.parkFactors).sort((a, b) => STATE.parkFactors[b].overall - STATE.parkFactors[a].overall);
  el.innerHTML = `<div style="max-height:300px;overflow-y:auto"><table><thead><tr><th>Team</th><th>Overall</th><th>HR</th><th>Run</th></tr></thead><tbody>${teams.map(t => {
    const pf = STATE.parkFactors[t];
    const color = pf.overall > 1.05 ? 'var(--tsu)' : pf.overall < 0.95 ? 'var(--td)' : 'var(--ts)';
    return `<tr><td><strong>${t}</strong></td><td style="color:${color};font-weight:500">${pf.overall.toFixed(2)}</td><td>${pf.hr.toFixed(2)}</td><td>${pf.run.toFixed(2)}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}

// Weather request deduplication — avoids hitting wttr.in again if data is fresh (10 min TTL)
const _weatherCache = new Map(); // team → { data, fetchedAt }
const WEATHER_TTL_MS = 600_000;  // 10 minutes

async function fetchWeather() {
  const el = document.getElementById('weather-display');
  if (!STATE.stadiumData) {
    try { STATE.stadiumData = await fetch('/api/stadiums').then(r => r.json()); } catch (e) {
      el.innerHTML = '<div class="ib warn">Failed to load stadium data. Make sure the server is running on localhost:3000.</div>';
      return;
    }
  }
  const teams = [...new Set(STATE.POOL.map(p => p.team).filter(Boolean))];
  if (!teams.length) {
    el.innerHTML = '<div class="ib warn">No teams found. Upload player data first (ROO or DK Salaries), then come back here to fetch weather.</div>';
    return;
  }

  const btn = document.getElementById('fetch-weather-btn');
  btn.textContent = 'Fetching...'; btn.disabled = true;

  try {
    const now = Date.now();
    const stale = teams.filter(t => { const c = _weatherCache.get(t); return !c || now - c.fetchedAt > WEATHER_TTL_MS; });
    if (stale.length) {
      const res = await fetch('/api/weather/batch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teams: stale })
      });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const fresh = await res.json();
      Object.entries(fresh).forEach(([t, d]) => _weatherCache.set(t, { data: d, fetchedAt: now }));
    }
    // Assemble result from cache (mix of fresh and previously-cached)
    STATE.weatherData = Object.fromEntries(teams.map(t => [t, _weatherCache.get(t)?.data]).filter(([, d]) => d));

    // Warn if every city failed (API down, not just one bad city)
    const allFailed = Object.values(STATE.weatherData).every(w => w.error);
    if (allFailed) {
      el.innerHTML = '<div class="ib warn">Weather data unavailable — wttr.in did not respond. Optimizer will run without weather adjustments.</div>';
      btn.textContent = 'Retry Weather'; btn.disabled = false;
      return;
    }

    renderWeatherDisplay();
    await loadWindEffects();
    renderSlateEnvironment();
    btn.textContent = 'Refresh Weather'; btn.disabled = false;
  } catch (e) {
    el.innerHTML = `<div class="ib warn">Weather fetch failed: ${esc(e.message)}. Optimizer will run without weather adjustments.</div>`;
    btn.textContent = 'Retry Weather'; btn.disabled = false;
  }
}

function renderWeatherDisplay() {
  const el = document.getElementById('weather-display');
  if (!STATE.weatherData || !Object.keys(STATE.weatherData).length) {
    el.innerHTML = '<div class="empty" style="padding:16px">Click "Fetch Weather" to load current conditions.</div>';
    return;
  }
  const domes = STATE.stadiumData?.domes || [];

  // Weather is now keyed by team code, not city name
  el.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px">${Object.entries(STATE.weatherData).map(([team, w]) => {
    if (w.error) return `<div class="sk-card"><strong>${esc(team)}</strong><div style="color:var(--td);font-size:11px">Error: ${esc(w.error)}</div></div>`;
    const wm = Engine.weatherMultiplier(w);
    const isDome = domes.includes(team);
    const we = STATE.windEffects[team] ?? null;
    const windDirLabel = we !== null ? (we > 0.3 ? 'Out' : we < -0.3 ? 'In' : 'Neutral') : '';
    const windDirColor = we !== null ? (we > 0.3 ? 'var(--tsu)' : we < -0.3 ? 'var(--td)' : 'var(--ts)') : 'var(--ts)';
    return `<div class="sk-card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <strong style="font-size:12px">${esc(team)}</strong>
        ${isDome ? '<span class="pill pg" style="font-size:9px">DOME</span>' : `<span class="pill ${wm.risk === 'high' ? 'pd' : wm.risk === 'moderate' ? 'pw' : 'psu'}" style="font-size:9px">${wm.label}</span>`}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:11px">
        <div>Temp: <strong>${w.temp_f || '?'}F</strong></div>
        <div>Wind: <strong>${w.wind_mph || '?'} mph ${w.wind_dir ? esc(w.wind_dir) : ''}</strong></div>
        <div>Precip: <strong>${w.precip_chance || 0}%</strong></div>
        <div>Hit mult: <strong style="color:${wm.hitting > 1.02 ? 'var(--tsu)' : wm.hitting < 0.98 ? 'var(--td)' : 'var(--ts)'}">${isDome ? '1.00' : wm.hitting.toFixed(2)}</strong></div>
        ${windDirLabel ? `<div style="grid-column:1/-1">Dir effect: <strong style="color:${windDirColor}">${windDirLabel}</strong></div>` : ''}
      </div>
    </div>`;
  }).join('')}</div>`;
}

function renderTeamScoringDisplay() {
  const el = document.getElementById('team-scoring-display');
  const teams = Object.keys(STATE.TEAM_SCORING).sort();
  if (!teams.length) {
    el.innerHTML = '<div class="empty" style="padding:16px">Upload a Team Scoring CSV to see team-level metrics.</div>';
    return;
  }
  el.innerHTML = `<div class="tbl-wrap"><table>
    <thead><tr>
      <th>Team</th><th>Opp SP</th><th>Avg Score</th><th>8+ Runs</th>
      <th>DK Top Score</th><th>DK Own%</th><th>Win %</th>
      <th>Avg 1st</th><th>1st Lead%</th><th>Avg 5th</th><th>5th Lead%</th><th>Adj</th>
    </tr></thead>
    <tbody>${teams.map(t => {
      const s = STATE.TEAM_SCORING[t];
      const adj = Engine.teamScoringAdjustment({ team: t, opp: '', rosterPos: '' }, STATE.TEAM_SCORING);
      const adjVal = adj.batting;
      const adjColor = adjVal > 1.02 ? 'var(--tsu)' : adjVal < 0.98 ? 'var(--td)' : 'var(--ts)';
      return `<tr>
        <td><strong>${esc(t)}</strong></td>
        <td style="font-size:11px">${esc(s.oppSP)}</td>
        <td>${s.avgScore.toFixed(2)}</td>
        <td>${s.eightPlusRuns.toFixed(1)}%</td>
        <td>${s.dkTopScore.toFixed(1)}%</td>
        <td>${s.dkTeamOwn.toFixed(1)}%</td>
        <td><span class="pill ${s.winPct >= 50 ? 'psu' : s.winPct >= 40 ? 'pw' : 'pd'}" style="font-size:10px">${s.winPct.toFixed(0)}%</span></td>
        <td>${s.avg1st.toFixed(2)}</td>
        <td>${s.firstLeadPct.toFixed(0)}%</td>
        <td>${s.avg5th.toFixed(2)}</td>
        <td>${s.fifthLeadPct.toFixed(0)}%</td>
        <td><strong style="color:${adjColor}">${adjVal.toFixed(3)}</strong></td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PORTFOLIO BUILDER TAB
// ═══════════════════════════════════════════════════════════════════════════════

// Read checked team chips from a container div
function getCheckedTeams(containerId) {
  return [...document.querySelectorAll(`#${containerId} .team-chip.selected`)].map(el => el.dataset.team);
}

// ── Player Exposure Overrides ─────────────────────────────────────────────────
function addExposureOverride() {
  const inp = document.getElementById('exp-override-search');
  if (!inp) return;
  const q = inp.value.trim().toLowerCase();
  if (!q) return;
  const player = STATE.POOL.find(p => p.name.toLowerCase().includes(q));
  if (!player) { inp.style.borderColor = 'var(--brd-d)'; return; }
  inp.style.borderColor = '';
  if (!STATE.playerExposureOverrides[player.name]) {
    STATE.playerExposureOverrides[player.name] = { min: null, max: null };
  }
  inp.value = '';
  renderExposureOverrides();
  saveSession();
}

function removeExposureOverride(name) {
  delete STATE.playerExposureOverrides[name];
  renderExposureOverrides();
  saveSession();
}

function updateExposureOverride(name, field, val) {
  if (!STATE.playerExposureOverrides[name]) STATE.playerExposureOverrides[name] = { min: null, max: null };
  const v = val === '' ? null : Math.max(0, Math.min(100, parseFloat(val)));
  STATE.playerExposureOverrides[name][field] = isNaN(v) ? null : v;
  saveSession();
}

function renderExposureOverrides() {
  const el = document.getElementById('exp-override-list');
  if (!el) return;
  const names = Object.keys(STATE.playerExposureOverrides);
  if (!names.length) {
    el.innerHTML = '<div style="font-size:11px;color:var(--tt);padding:6px 0">No overrides set. Search for a player above to add one.</div>';
    return;
  }
  el.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:12px">
    <thead><tr>
      <th style="text-align:left;padding:4px 6px;font-size:10px;color:var(--tt);font-weight:500;text-transform:uppercase;letter-spacing:.04em">Player</th>
      <th style="text-align:left;padding:4px 6px;font-size:10px;color:var(--tt);font-weight:500;text-transform:uppercase;letter-spacing:.04em">Pos</th>
      <th style="padding:4px 6px;font-size:10px;color:var(--tt);font-weight:500;text-transform:uppercase;letter-spacing:.04em">Min %</th>
      <th style="padding:4px 6px;font-size:10px;color:var(--tt);font-weight:500;text-transform:uppercase;letter-spacing:.04em">Max %</th>
      <th></th>
    </tr></thead>
    <tbody>${names.map(name => {
      const ov = STATE.playerExposureOverrides[name];
      const p = STATE.POOL.find(pl => pl.name === name);
      const pos = p ? (p.dkPos || '—') : '—';
      // Use data-name on each control so the player name is passed via dataset,
      // avoiding the double-quote collision that breaks inline onclick/oninput handlers.
      return `<tr>
        <td style="padding:4px 6px"><strong>${esc(name)}</strong></td>
        <td style="padding:4px 6px"><span class="pill pi" style="font-size:10px">${esc(pos)}</span></td>
        <td style="padding:4px 6px;text-align:center"><input type="number" min="0" max="100" step="5" value="${ov.min ?? ''}" placeholder="—" data-name="${escAttr(name)}" data-field="min" style="width:52px;font-size:11px;padding:2px 4px;border:0.5px solid var(--brd-s);border-radius:4px;background:var(--bp);color:var(--tp);text-align:center" oninput="updateExposureOverride(this.dataset.name,this.dataset.field,this.value)"></td>
        <td style="padding:4px 6px;text-align:center"><input type="number" min="0" max="100" step="5" value="${ov.max ?? ''}" placeholder="—" data-name="${escAttr(name)}" data-field="max" style="width:52px;font-size:11px;padding:2px 4px;border:0.5px solid var(--brd-s);border-radius:4px;background:var(--bp);color:var(--tp);text-align:center" oninput="updateExposureOverride(this.dataset.name,this.dataset.field,this.value)"></td>
        <td style="padding:4px 6px"><button class="btn" style="padding:2px 7px;font-size:10px;color:var(--td)" data-name="${escAttr(name)}" onclick="removeExposureOverride(this.dataset.name)">✕</button></td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
}

// ── Team Exposure Overrides ───────────────────────────────────────────────────
function toggleTeamExposureOverride(team) {
  if (STATE.teamExposureOverrides[team]) {
    delete STATE.teamExposureOverrides[team];
  } else {
    STATE.teamExposureOverrides[team] = { min: null, max: null };
  }
  renderTeamExposureOverrides();
  saveSession();
}

function updateTeamExposureOverride(team, field, val) {
  if (!STATE.teamExposureOverrides[team]) STATE.teamExposureOverrides[team] = { min: null, max: null };
  const v = val === '' ? null : Math.max(0, Math.min(100, parseFloat(val)));
  STATE.teamExposureOverrides[team][field] = isNaN(v) ? null : v;
  saveSession();
}

function renderTeamExposureOverrides() {
  const teams = [...new Set(STATE.POOL.map(p => p.team).filter(Boolean))].sort();
  const chipsEl = document.getElementById('team-exp-override-chips');
  const listEl = document.getElementById('team-exp-override-list');
  if (!chipsEl || !listEl) return;

  if (!teams.length) {
    chipsEl.innerHTML = '<span style="font-size:11px;color:var(--tt)">Load players first</span>';
    listEl.innerHTML = '';
    return;
  }

  chipsEl.innerHTML = teams.map(t => {
    const active = !!STATE.teamExposureOverrides[t];
    return `<span class="chip${active ? ' selected' : ''}" style="cursor:pointer" onclick="toggleTeamExposureOverride('${escAttr(t)}')">${esc(t)}</span>`;
  }).join('');

  const overrideTeams = Object.keys(STATE.teamExposureOverrides);
  if (!overrideTeams.length) {
    listEl.innerHTML = '<div style="font-size:11px;color:var(--tt);padding:6px 0">Click a team above to add an override.</div>';
    return;
  }

  listEl.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:12px">
    <thead><tr>
      <th style="text-align:left;padding:4px 6px;font-size:10px;color:var(--tt);font-weight:500;text-transform:uppercase;letter-spacing:.04em">Team</th>
      <th style="padding:4px 6px;font-size:10px;color:var(--tt);font-weight:500;text-transform:uppercase;letter-spacing:.04em">Min %</th>
      <th style="padding:4px 6px;font-size:10px;color:var(--tt);font-weight:500;text-transform:uppercase;letter-spacing:.04em">Max %</th>
      <th></th>
    </tr></thead>
    <tbody>${overrideTeams.map(team => {
      const ov = STATE.teamExposureOverrides[team];
      return `<tr>
        <td style="padding:4px 6px"><strong>${esc(team)}</strong></td>
        <td style="padding:4px 6px;text-align:center"><input type="number" min="0" max="100" step="5" value="${ov.min ?? ''}" placeholder="—" style="width:52px;font-size:11px;padding:2px 4px;border:0.5px solid var(--brd-s);border-radius:4px;background:var(--bp);color:var(--tp);text-align:center" oninput="updateTeamExposureOverride('${escAttr(team)}','min',this.value)"></td>
        <td style="padding:4px 6px;text-align:center"><input type="number" min="0" max="100" step="5" value="${ov.max ?? ''}" placeholder="—" style="width:52px;font-size:11px;padding:2px 4px;border:0.5px solid var(--brd-s);border-radius:4px;background:var(--bp);color:var(--tp);text-align:center" oninput="updateTeamExposureOverride('${escAttr(team)}','max',this.value)"></td>
        <td style="padding:4px 6px"><button class="btn" style="padding:2px 7px;font-size:10px;color:var(--td)" onclick="toggleTeamExposureOverride('${escAttr(team)}')">✕</button></td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
}

// Populate lock/ban team chip selectors from the current pool
function renderPortfolioTeamSelectors() {
  const teams = [...new Set(STATE.POOL.map(p => p.team).filter(Boolean))].sort();
  if (!teams.length) return;
  ['port-lock-teams', 'port-ban-teams'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    // Preserve existing selections
    const selected = new Set([...el.querySelectorAll('.team-chip.selected')].map(c => c.dataset.team));
    el.innerHTML = teams.map(t =>
      `<span class="team-chip chip${selected.has(t) ? ' selected' : ''}" data-team="${escAttr(t)}" onclick="toggleTeamChip(this,'${escAttr(id)}')">${esc(t)}</span>`
    ).join('');
  });
  renderTeamExposureOverrides();
}

function toggleTeamChip(el, containerId) {
  const team = el.dataset.team;
  const lockEl = document.getElementById('port-lock-teams');
  const banEl = document.getElementById('port-ban-teams');

  // A team cannot be both locked and banned — deselect from the other panel
  if (!el.classList.contains('selected')) {
    const otherId = containerId === 'port-lock-teams' ? 'port-ban-teams' : 'port-lock-teams';
    const other = document.querySelector(`#${otherId} .team-chip[data-team="${escAttr(team)}"]`);
    if (other) other.classList.remove('selected');
  }
  el.classList.toggle('selected');
  validatePortfolioSettings();
}

function toggleStackMix() {
  const val = document.getElementById('port-stack-size')?.value;
  const row = document.getElementById('stack-mix-row');
  if (row) row.style.display = val === 'mix' ? '' : 'none';
}

function toggleSimFilter() {
  const on = document.getElementById('port-sim-filter')?.checked;
  const opts = document.getElementById('sim-filter-options');
  if (opts) opts.style.display = on ? 'flex' : 'none';  // flex-direction:column set in HTML
}

function onPayoutTypeChange() {
  const val = document.getElementById('port-payout-type')?.value;
  const row = document.getElementById('custom-payout-row');
  if (row) row.style.display = val === 'custom' ? '' : 'none';
}

// #11: Warn when Score Diversity is set to a GPP value but the user switched
// to cash mode (GPP variance settings produce overly optimistic floors in cash sim).
// Fires once per change to avoid spam.
function onContestTypeChange() {
  const ct = document.getElementById('port-contest-type')?.value;

  // Ownership penalty and max avg ownership are GPP-only concepts — they have no
  // effect when contestType is cash or single (those use different lineup generators
  // that don't accept an ownershipLambda). Dim and disable the controls to prevent
  // users from thinking their settings are active when they aren't.
  const isGpp = ct === 'gpp';
  const ownershipIds = ['port-own-lambda', 'own-lambda-label', 'port-max-avg-own'];
  ownershipIds.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.tagName === 'INPUT') el.disabled = !isGpp;
    el.style.opacity = isGpp ? '' : '0.4';
  });
  // Also dim the parent config-item labels so the whole block looks inactive
  ['port-own-lambda', 'port-max-avg-own'].forEach(id => {
    const item = document.getElementById(id)?.closest('.config-item');
    if (item) item.style.opacity = isGpp ? '' : '0.4';
  });

  // Dim and disable GPP-only controls (Enforce Contrarian, etc.)
  document.querySelectorAll('.port-gpp-only').forEach(el => {
    if (el.tagName === 'INPUT') el.disabled = !isGpp;
    el.closest('label,div')?.querySelectorAll('strong,span').forEach(s => s.style.opacity = isGpp ? '' : '0.4');
    el.style.opacity = isGpp ? '' : '0.4';
  });

  if (ct === 'cash') {
    const sd = parseFloat(document.getElementById('sim-diversity')?.value);
    if (sd > 1.05) {
      showToast(
        `Score Diversity is ${sd.toFixed(1)}× (GPP setting). For cash floor accuracy, reset to 1.0× in the Simulator tab.`,
        'warn', 6000
      );
    }
  }
}

function toggleBringBackOptions() {
  const enabled = document.getElementById('port-bb-enabled')?.checked;
  const rows = ['bb-options-row', 'bb-target-row'];
  rows.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.opacity = enabled ? '1' : '0.4';
  });
}

async function loadPitcherHands() {
  const btn = document.getElementById('fetch-hands-btn');
  const statusEl = document.getElementById('lineups-status');
  if (btn) { btn.textContent = 'Fetching…'; btn.disabled = true; }
  try {
    const res = await fetch('/api/pitcher-hands');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Unknown error');
    const handsMap = data.hands; // { name: throwingHand, 'bat:name': battingHand }
    const normName = name => (name || '').toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
    let merged = 0;
    STATE.POOL.forEach(p => {
      const norm = normName(p.name);
      const isPitcher = Engine.rp(p, 'P');
      if (isPitcher) {
        // Pitchers: store throwing hand so platoon logic can look them up
        if (handsMap[norm]) { p.hand = handsMap[norm]; merged++; }
      } else {
        // Batters: store batting side (bat: prefix) for platoon split calculations
        const batHand = handsMap[`bat:${norm}`];
        if (batHand && !p.hand) { p.hand = batHand; merged++; }
      }
    });
    // Also update ROO source pools so blended projections carry the hand data
    STATE.ROO_SOURCES.forEach(src => {
      if (!src) return;
      src.data.forEach(p => {
        const norm = normName(p.name);
        const isPitcher = (p.pos || '').toUpperCase().includes('P');
        if (isPitcher) {
          if (handsMap[norm] && !p.hand) p.hand = handsMap[norm];
        } else {
          const batHand = handsMap[`bat:${norm}`];
          if (batHand && !p.hand) p.hand = batHand;
        }
      });
    });
    if (statusEl) statusEl.innerHTML = `<span class="pill psu">Pitcher hands loaded — ${merged} players updated (${Object.keys(handsMap).length} total)</span>`;
    showToast(`Pitcher handedness loaded — ${merged} pool players updated`, 'success');
    renderPlayers();
  } catch (e) {
    if (statusEl) statusEl.innerHTML = `<span class="pill warn">Hands fetch failed: ${e.message}</span>`;
    showToast('Pitcher hands fetch failed: ' + e.message, 'warn');
  } finally {
    if (btn) { btn.textContent = 'Fetch Pitcher Hands'; btn.disabled = false; }
  }
}

// Fix 8: Apply recommended portfolio settings based on current slate size.
// Reads game count from the loaded pool and calls Engine.getSlateDefaults().
function applySlateDefaults() {
  const gameCount = new Set(STATE.POOL.filter(p => p.game).map(p => p.game)).size || 8;
  const defaults = Engine.getSlateDefaults(gameCount);
  const numLu = parseInt(document.getElementById('port-num-lineups')?.value) || 20;

  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) { el.value = val; el.dispatchEvent(new Event('change')); }
  };

  set('port-max-overlap', defaults.maxOverlap);
  set('port-stack-pct5', defaults.stackPct5);
  set('port-max-game-exposure', Math.round(defaults.maxGameExposure * 100));
  // SP pair cap scales with lineup count: max 25% share any pitcher duo across the portfolio
  set('port-max-sp-pair', Math.max(3, Math.ceil(numLu * 0.25)));

  showToast(`Slate defaults applied: ${defaults.label} (${gameCount} games) — overlap=${defaults.maxOverlap}, 5-man=${defaults.stackPct5}%, game cap=${Math.round(defaults.maxGameExposure * 100)}%`, 'info', 5000);
  saveSession();
}

// ── Historical Score Benchmarks ───────────────────────────────────────────────
let _cachedBenchmarks = null;

async function loadHistoryBenchmarks() {
  const el = document.getElementById('history-benchmarks');
  if (!el) return;
  el.style.display = 'block';
  el.innerHTML = '<span style="color:var(--tt)">Loading…</span>';
  try {
    const data = await fetch('/api/history/score-benchmarks').then(r => r.json());
    _cachedBenchmarks = data;
    if (!data.sufficient) {
      el.innerHTML = `<span style="color:var(--tw)">${esc(data.message)}</span>`;
      return;
    }
    const p = data.scorePercentiles;
    const cashColor = data.estCashLine ? 'var(--ti)' : 'var(--tt)';
    const winColor  = data.estWinLine  ? 'var(--tsu)' : 'var(--tt)';
    const divSug = data.simDiversitySuggestion;
    const lam    = data.lambdaSuggestion;
    el.innerHTML = `
      <div style="margin-bottom:8px">
        <span style="color:var(--tt);text-transform:uppercase;font-size:10px;letter-spacing:.05em">Your Score Distribution (${data.count} contests)</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:6px;margin-bottom:8px;text-align:center">
        ${[['P10',p.p10],['P25',p.p25],['P50 (med)',p.p50],['P75',p.p75],['P90',p.p90],['P95',p.p95]].map(([l,v]) =>
          `<div><div style="font-size:9px;color:var(--tt)">${l}</div><div style="font-weight:600;font-size:13px">${v}</div></div>`
        ).join('')}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
        <div style="background:var(--bp);border-radius:4px;padding:6px 8px">
          <div style="font-size:9px;color:var(--tt);margin-bottom:2px" title="10th-percentile of cashing scores across contests with ≥100 entries. Robust to one-off disaster slates.">EST. CASH LINE (top 22% finishes, p10) <span style="cursor:help">ⓘ</span></div>
          <div style="font-size:14px;font-weight:700;color:${cashColor}">${data.estCashLine ?? 'need more data'} pts</div>
          ${data.benchmarkMeta?.cashSampleSize > 0 ? `<div style="font-size:9px;color:var(--tt);margin-top:2px">from ${data.benchmarkMeta.cashSampleSize} entries · median ${data.benchmarkMeta.cashMedian} · min observed ${data.benchmarkMeta.cashMinObserved}</div>` : ''}
          <button class="btn" style="font-size:10px;padding:1px 6px;margin-top:4px" onclick="applyHistoryCashLine()">Set Cash Line</button>
        </div>
        <div style="background:var(--bp);border-radius:4px;padding:6px 8px">
          <div style="font-size:9px;color:var(--tt);margin-bottom:2px" title="10th-percentile of top-5%-finish scores. Excludes contests under 100 entries.">EST. WIN LINE (top 5% finishes, p10) <span style="cursor:help">ⓘ</span></div>
          <div style="font-size:14px;font-weight:700;color:${winColor}">${data.estWinLine ?? 'need more data'} pts</div>
          ${data.benchmarkMeta?.winSampleSize > 0 ? `<div style="font-size:9px;color:var(--tt);margin-top:2px">from ${data.benchmarkMeta.winSampleSize} entries · median ${data.benchmarkMeta.winMedian} · min observed ${data.benchmarkMeta.winMinObserved}</div>` : ''}
          <button class="btn" style="font-size:10px;padding:1px 6px;margin-top:4px" onclick="applyHistoryWinLine()">Set Win Line</button>
        </div>
      </div>
      ${data.benchmarkMeta?.excludedSmallFields > 0 ? `<div style="font-size:10px;color:var(--tt);margin-bottom:8px;padding:4px 8px;background:var(--bs);border-radius:3px">Excluded ${data.benchmarkMeta.excludedSmallFields} small-field contests (&lt; ${data.benchmarkMeta.minContestSize} entries) — H2H, satellites, and beginner pools have score distributions that don't predict large-field cash lines.</div>` : ''}
      ${divSug ? `<div style="margin-bottom:4px;padding:5px 8px;background:var(--bp);border-radius:4px">
        <span style="color:var(--tt)">Sim Diversity: </span>
        actual spread = <strong>${divSug.actStd}</strong> pts · projected spread = <strong>${divSug.projStd}</strong> pts ·
        ratio <strong style="color:${Math.abs(divSug.ratio-1)<0.1?'var(--tsu)':'var(--tw)'}">${divSug.ratio.toFixed(2)}×</strong> →
        suggested diversity <strong>${divSug.suggested.toFixed(2)}</strong>
        <button class="btn" style="font-size:10px;padding:1px 6px;margin-left:6px" onclick="applyHistorySimDiversity()">Apply</button>
      </div>` : ''}
      ${lam ? `<div style="padding:5px 8px;background:var(--bp);border-radius:4px;font-size:11px">
        <span style="color:var(--tt)">Ownership Lambda: </span>
        cash rate <strong>${lam.cashRate}%</strong> vs break-even <strong>${lam.breakEvenPct}%</strong> →
        <strong style="color:${lam.hint==='maintain'?'var(--tsu)':'var(--tw)'}">${lam.hint==='increase'?'↑ increase':lam.hint==='decrease'?'↓ decrease':'✓ maintain'} lambda</strong>
      </div>` : ''}`;
  } catch (e) {
    el.innerHTML = `<span style="color:var(--tw)">Failed: ${esc(e.message)}</span>`;
  }
}

function applyHistoryCashLine() {
  const data = _cachedBenchmarks;
  if (!data?.estCashLine) { showToast('Load Historical Benchmarks first, or not enough top-finish data yet', 'warn'); return; }
  const el = document.getElementById('port-cash-line');
  if (el) { el.value = data.estCashLine; saveSession(); }
  showToast(`Cash line set to ${data.estCashLine} pts (from your top-22%-finish contests)`, 'info');
}

function applyHistoryWinLine() {
  const data = _cachedBenchmarks;
  if (!data?.estWinLine) { showToast('Load Historical Benchmarks first, or not enough top-5%-finish data yet', 'warn'); return; }
  const el = document.getElementById('port-win-line');
  if (el) { el.value = data.estWinLine; saveSession(); }
  showToast(`Win line set to ${data.estWinLine} pts (from your top-5%-finish contests)`, 'info');
}

function applyHistorySimDiversity() {
  const data = _cachedBenchmarks;
  const sug = data?.simDiversitySuggestion;
  if (!sug) { showToast('No sim diversity data — need saved lineups with both projected and actual scores', 'warn'); return; }
  const el = document.getElementById('sim-diversity');
  if (el) { el.value = sug.suggested.toFixed(2); el.dispatchEvent(new Event('input')); saveSession(); }
  showToast(`Sim diversity set to ${sug.suggested.toFixed(2)} (actual/projected spread ratio = ${sug.ratio.toFixed(2)}×)`, 'info');
}

function validatePortfolioSettings() {
  const warningsEl = document.getElementById('port-warnings');
  const warnings = [];

  const numLineups = parseInt(document.getElementById('port-num-lineups').value) || 20;
  const pitcherMaxPct = parseInt(document.getElementById('port-max-pitcher').value) / 100 || 0.6;
  const lockedTeams = getCheckedTeams('port-lock-teams');
  const bannedTeams = getCheckedTeams('port-ban-teams');

  // Check pitcher viability: use the calibrated pool so scratched/benched pitchers
  // don't inflate the count and mask a real shortage.
  const viablePitchers = getCalibratedPool().filter(p => rp(p, 'P') && p.salary > 0 && (p.median > 0 || p.avgPpg > 0)).length;
  const neededPitcherAppearances = 2 * numLineups; // 2 P slots per lineup
  // Correct formula: each pitcher can appear at most floor(numLineups * pitcherMaxPct) times.
  const maxPitcherAppearances = viablePitchers * Math.floor(numLineups * pitcherMaxPct);
  if (viablePitchers > 0 && maxPitcherAppearances < neededPitcherAppearances) {
    warnings.push(`<strong>Pitcher exposure too low:</strong> ${viablePitchers} viable pitcher${viablePitchers === 1 ? '' : 's'} at ${Math.round(pitcherMaxPct * 100)}% max = ${maxPitcherAppearances} total appearances, but ${neededPitcherAppearances} are needed (${numLineups} lineups × 2 P slots). The engine will auto-relax the cap to complete the portfolio, but consider raising Pitcher Exposure or adding more pitchers.`);
  }

  // Warn when 5-man only is selected but not enough 5-man stacks are loaded
  const stackSizeValV = document.getElementById('port-stack-size')?.value;
  if (stackSizeValV === '5') {
    const avail5 = STATE.STACKS5.filter(s => !bannedTeams.includes(s.team)).length;
    if (avail5 === 0) {
      warnings.push(`<strong>No 5-man stacks loaded:</strong> Stack Size is set to 5-man only but no 5-man stacks file has been uploaded. Upload a 5-man stacks CSV or switch Stack Size to Mix or 3-man.`);
    } else if (avail5 < Math.ceil(numLineups / 5)) {
      warnings.push(`<strong>Low 5-man stack variety:</strong> Only ${avail5} 5-man stacks loaded for ${numLineups} lineups — the engine may fall short of ${numLineups}. Consider loading more 5-man stack combinations (aim for at least ${Math.ceil(numLineups / 4)}) or reducing the lineup count.`);
    }
  }

  // Warn if a locked team has no stack in the stacks files
  lockedTeams.forEach(team => {
    const hasStack = [...STATE.STACKS3, ...STATE.STACKS5].some(s => s.team === team);
    if (!hasStack) {
      const batters = STATE.POOL.filter(p => p.team === team && !rp(p, 'P') && p.median > 0);
      if (batters.length >= 2) {
        warnings.push(`<strong>${esc(team)} has no stacks file entry</strong> — will build a virtual 3-man stack from top-projected batters (${esc(batters.slice(0, 3).map(p => p.name).join(', '))}).`);
      } else {
        warnings.push(`<strong>${esc(team)} cannot be locked:</strong> no stacks file entry and fewer than 2 projected batters on slate.`);
      }
    }
  });

  // Warn if locked + banned overlap (shouldn't happen via UI but guard anyway)
  lockedTeams.filter(t => bannedTeams.includes(t)).forEach(t => {
    warnings.push(`<strong>${esc(t)}</strong> is both locked and banned — it will be treated as banned.`);
  });

  // Warn when Sim ROI Filter is on with a max ROI ≤ 0 in GPP (filters out all positive-ROI lineups)
  const simFilterOn = document.getElementById('port-sim-filter')?.checked;
  if (simFilterOn) {
    const roiMaxRaw = document.getElementById('port-sim-roi-max')?.value;
    const roiMinRaw = document.getElementById('port-sim-roi-min')?.value;
    const roiMax = roiMaxRaw !== '' ? parseFloat(roiMaxRaw) : null;
    const roiMin = roiMinRaw !== '' ? parseFloat(roiMinRaw) : null;
    const ct = document.getElementById('port-contest-type')?.value;
    if (roiMax !== null && roiMax <= 0 && ct === 'gpp') {
      warnings.push(`<strong>ROI Band max is ${roiMax}%</strong> — this filters out all lineups with positive expected ROI, keeping only break-even or losing lineups. In GPP you almost certainly want a <em>higher</em> max (or leave it blank to keep top N by ROI). <a href="#" onclick="document.getElementById('port-sim-roi-max').value='';saveSession();validatePortfolioSettings();return false" style="color:var(--ti)">Clear it</a>.`);
    }
    if (roiMin !== null && roiMax !== null && roiMin > roiMax) {
      warnings.push(`<strong>ROI Band min (${roiMin}%) &gt; max (${roiMax}%)</strong> — no lineups can satisfy this range. Swap the values or clear the band.`);
    }
  }

  if (warnings.length) {
    warningsEl.style.display = 'block';
    warningsEl.innerHTML = warnings.map(w => `<div class="ib warn" style="margin-bottom:6px">${w}</div>`).join('');
  } else {
    warningsEl.style.display = 'none';
    warningsEl.innerHTML = '';
  }
}

// ── Portfolio Web Worker ──────────────────────────────────────────────────────
// Offloads Engine.buildPortfolio (and its internal sim-filter pass) to a
// background thread so the UI stays responsive during 60s+ generation runs.
let _activePortfolioWorker = null;

function buildPortfolioWorker(pool, opts, onProgress, simControls = null) {
  return new Promise((resolve, reject) => {
    if (_activePortfolioWorker) {
      _activePortfolioWorker.terminate();
      _activePortfolioWorker = null;
    }
    const worker = new Worker('sim-worker.js');
    _activePortfolioWorker = worker;

    // Safety timeout: if the worker stops sending progress for 3 minutes, assume it
    // crashed silently (OOM, browser kill) without firing onerror. Without this, the
    // promise hangs forever and the Generate button never re-enables.
    const WORKER_TIMEOUT_MS = 180_000;
    let lastActivityAt = Date.now();
    const timeoutId = setInterval(() => {
      if (Date.now() - lastActivityAt > WORKER_TIMEOUT_MS) {
        clearInterval(timeoutId);
        worker.terminate();
        _activePortfolioWorker = null;
        reject(new Error('Portfolio worker timed out after 3 minutes with no response. Try reducing lineup count or disabling Sim Filter.'));
      }
    }, 5000);

    worker.onmessage = ({ data }) => {
      lastActivityAt = Date.now();
      if (data.type === 'progress') {
        if (onProgress) onProgress(data.built, data.target);
      } else if (data.type === 'result') {
        clearInterval(timeoutId);
        worker.terminate();
        _activePortfolioWorker = null;
        resolve(data.result);
      } else if (data.type === 'error') {
        clearInterval(timeoutId);
        worker.terminate();
        _activePortfolioWorker = null;
        reject(new Error(data.message));
      }
    };
    worker.onerror = (e) => {
      clearInterval(timeoutId);
      worker.terminate();
      _activePortfolioWorker = null;
      reject(new Error(e.message || 'Portfolio worker error'));
    };
    const controls = simControls || { corrScale: 1.0, simDiversity: 1.0 };
    worker.postMessage({
      type: 'buildPortfolio',
      payload: {
        pool,
        opts,
        corrScale: controls.corrScale,
        simDiversity: controls.simDiversity,
      }
    });
  });
}

function simulatePortfolioWorker(lineups, pool, numSims, contestType, manualCashLine, manualWinLine, payoutType, contestSize, customPayoutConfig = null, simControls = null) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('sim-worker.js');
    worker.onmessage = ({ data }) => {
      if (data.type === 'result') {
        worker.terminate();
        resolve(data.results);
      } else if (data.type === 'error') {
        worker.terminate();
        reject(new Error(data.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'Sim worker error'));
    };
    const controls = simControls || { corrScale: 1.0, simDiversity: 1.0 };
    worker.postMessage({
      type: 'simulatePortfolio',
      payload: {
        lineups,
        pool,
        numSims,
        contestType,
        manualCashLine,
        manualWinLine,
        payoutType,
        contestSize,
        customPayoutConfig,
        corrScale: controls.corrScale,
        simDiversity: controls.simDiversity,
      }
    });
  });
}

function generatePortfolio() {
  if (!STATE.POOL.length) return;
  const numLineups = parseInt(document.getElementById('port-num-lineups').value) || 20;
  const maxExposure = parseInt(document.getElementById('port-max-exposure').value) / 100 || 0.6;
  const maxExposurePitcher = parseInt(document.getElementById('port-max-pitcher').value) / 100 || 0.6;
  const contestType = document.getElementById('port-contest-type').value || 'gpp';
  const portContestSize = parseInt(document.getElementById('port-contest-size').value) || 1000;
  const maxOverlapVal = parseInt(document.getElementById('port-max-overlap')?.value) || 0;
  const allowBvP = document.getElementById('port-allow-bvp')?.checked || false;
  const stackSizeVal = document.getElementById('port-stack-size')?.value || 'mix';
  const stackSize = stackSizeVal !== 'mix' ? parseInt(stackSizeVal) : null;
  const stackPct5Raw = document.getElementById('port-stack-pct5')?.value;
  const stackPct5 = stackSize == null && stackPct5Raw !== '' && stackPct5Raw != null ? parseInt(stackPct5Raw) : null;
  const lockedTeams = getCheckedTeams('port-lock-teams');
  const bannedTeams = getCheckedTeams('port-ban-teams');
  const simFilter = document.getElementById('port-sim-filter')?.checked || false;
  const simFilterPct = parseInt(document.getElementById('port-sim-filter-pct')?.value) || 50;
  const simFilterSims = parseInt(document.getElementById('port-sim-filter-sims')?.value) || 1500;
  const simROIMinRaw = document.getElementById('port-sim-roi-min')?.value;
  const simROIMaxRaw = document.getElementById('port-sim-roi-max')?.value;
  const simROIMin = simFilter && simROIMinRaw !== '' && simROIMinRaw != null ? parseFloat(simROIMinRaw) : null;
  const simROIMax = simFilter && simROIMaxRaw !== '' && simROIMaxRaw != null ? parseFloat(simROIMaxRaw) : null;
  const payoutType = document.getElementById('port-payout-type')?.value || 'top20';

  // Bring-back settings
  const bbEnabled = document.getElementById('port-bb-enabled')?.checked !== false;
  const bbMinOppImplied = parseFloat(document.getElementById('port-bb-min-implied')?.value) || 4.0;
  const bbTargetRaw = document.getElementById('port-bb-target')?.value || 'auto';
  const bbTarget = bbTargetRaw === 'auto' ? null : parseInt(bbTargetRaw);

  // Secondary stack: cross-game 2–3 man cluster. '' / 'off' = disabled, else 'auto' | '2' | '3'.
  const secondaryStackRaw = document.getElementById('port-secondary-stack')?.value || 'off';
  const secondaryStack = secondaryStackRaw === 'off' ? null : secondaryStackRaw;

  // Ownership controls
  const ownershipLambda = parseFloat(document.getElementById('port-own-lambda')?.value || '4') / 100;
  const maxAvgOwnership = parseFloat(document.getElementById('port-max-avg-own')?.value) || 0;

  // Phase 3: Best Plays Automation controls
  const enforceContrarian = document.getElementById('port-enforce-contrarian')?.checked || false;
  const bringBackTargetPct = parseInt(document.getElementById('port-bring-back-target')?.value || '50') / 100;
  const showDiversityAnalysis = document.getElementById('port-diversity-analysis')?.checked || false;

  // Custom payout config (only when payoutType === 'custom')
  let customPayoutConfig = null;
  if (payoutType === 'custom') {
    const cashPct = parseFloat(document.getElementById('custom-cash-pct')?.value || '20') / 100;
    const cashMult = parseFloat(document.getElementById('custom-cash-mult')?.value || '2.5');
    const winPct = parseFloat(document.getElementById('custom-win-pct')?.value || '0.5') / 100;
    const winMult = parseFloat(document.getElementById('custom-win-mult')?.value || '15');
    customPayoutConfig = { cashPct, cashMult, winPct, winMult };
  }

  // Convert playerExposureOverrides from % to 0-1 ratios for engine
  const playerOverrides = {};
  Object.entries(STATE.playerExposureOverrides).forEach(([name, ov]) => {
    playerOverrides[name] = {
      min: ov.min != null ? ov.min / 100 : undefined,
      max: ov.max != null ? ov.max / 100 : undefined,
    };
    if (playerOverrides[name].min == null) delete playerOverrides[name].min;
    if (playerOverrides[name].max == null) delete playerOverrides[name].max;
  });
  // DEBUG: Log the actual overrides being sent to engine
  if (Object.keys(playerOverrides).length > 0) {
    console.log('[Portfolio] DEBUG - Player Overrides being sent to engine:', JSON.stringify(playerOverrides, null, 2));
  }

  // Convert teamExposureOverrides from % to 0-1 ratios for engine
  const teamOverrides = {};
  Object.entries(STATE.teamExposureOverrides).forEach(([team, ov]) => {
    teamOverrides[team] = {
      min: ov.min != null ? ov.min / 100 : undefined,
      max: ov.max != null ? ov.max / 100 : undefined,
    };
    if (teamOverrides[team].min == null) delete teamOverrides[team].min;
    if (teamOverrides[team].max == null) delete teamOverrides[team].max;
  });

  // Run validation warnings before generating (classic only)
  if (!isShowdown()) validatePortfolioSettings();

  // Constraint snapshot — diagnostic for tracing portfolio shortfalls.
  // Gated behind debug mode since it fires every portfolio build (chatty in normal use).
  // Run window.toggleDebug() in the console to see this.
  dgroup('[Portfolio] Active constraints', () => {
    console.log('Lineups requested:', numLineups);
    console.log('Stack mode:', stackSizeVal, '| 5-man %:', stackPct5 ?? 'n/a');
    console.log('Locked teams:', lockedTeams.length ? lockedTeams.join(', ') : 'none');
    console.log('Banned teams:', bannedTeams.length ? bannedTeams.join(', ') : 'none');
    console.log('Sim filter:', simFilter ? `ON (top ${simFilterPct}% of ${simFilterSims} sims, ROI ${simROIMin ?? '–'}–${simROIMax ?? '–'})` : 'OFF');
    const teamOvSummary = Object.entries(STATE.teamExposureOverrides)
      .map(([t, ov]) => `${t}: min=${ov.min ?? '–'}% max=${ov.max ?? '–'}%`).join(', ');
    console.log('Team overrides:', teamOvSummary || 'none');
    const playerOvSummary = Object.entries(STATE.playerExposureOverrides)
      .map(([n, ov]) => `${n}: min=${ov.min ?? '–'}% max=${ov.max ?? '–'}%`).join(', ');
    console.log('Player overrides:', playerOvSummary || 'none');
  });

  // Data staleness check — warn before building if Vegas/lineup data is stale.
  // Threshold matches the Vegas tab (2 hours) so users aren't double-warned.
  (() => {
    const warnings = [];
    if (!STATE.vegasData || !Object.keys(STATE.vegasData).length) {
      warnings.push('No Vegas data loaded — implied totals will default to 4.5 for all teams');
    } else {
      const times = Object.values(STATE.vegasData)
        .map(d => d.lastFetchedAt ? new Date(d.lastFetchedAt).getTime() : 0)
        .filter(t => t > 0);
      if (times.length === 0) {
        warnings.push('Vegas data has no fetch timestamp — may be stale');
      } else {
        const ageMin = Math.round((Date.now() - Math.max(...times)) / 60000);
        if (ageMin > 120) warnings.push(`Vegas data is ${ageMin}min old — consider refreshing`);
      }
    }
    const hasConfirmed = STATE.POOL.some(p => p.isConfirmed === true);
    if (!hasConfirmed && STATE.POOL.length > 0) {
      warnings.push('No confirmed batting orders — scratched/benched players may appear in lineups. Lineups will be refreshed automatically before generation.');
    }
    if (warnings.length) {
      showToast('⚠ ' + warnings.join(' · '), 'warn', 7000);
    }
  })();

  const btn = document.getElementById('gen-portfolio-btn');
  btn.textContent = 'Generating...'; btn.disabled = true;

  const _portStartMs = Date.now();

  // Use requestAnimationFrame + async to keep UI responsive
  requestAnimationFrame(async () => {
    try {
      // Silently refresh confirmed lineups before building the pool so late
      // scratches (Bolte, Muncy, etc.) are caught without requiring a manual refresh.
      if (STATE.POOL.length > 0) {
        try {
          const today = new Date().toISOString().substring(0, 10);
          const res = await fetch('/api/lineups/' + today);
          if (res.ok) {
            const data = await res.json();
            if (data.success) {
              STATE.confirmedLineups = {};
              (data.games || []).forEach(g => { STATE.confirmedLineups[g.gamePk] = g; });
              applyConfirmedToPool();
            }
          }
        } catch (_) { /* network failure — use whatever lineup data we already have */ }

        // Silently refresh injury data so IL/DL players placed on the list in the
        // last 48 hours are caught even if the user hasn't manually fetched injuries.
        try {
          const injRes = await fetch('/api/injuries');
          if (injRes.ok) {
            const injData = await injRes.json();
            if (injData.success && injData.flagged?.length) {
              STATE.injuryData = injData.flagged;
              applyInjuriesToPool();
            }
          }
        } catch (_) { /* ignore — use existing injury flags if present */ }
      }

      // Warn about teams that still don't have confirmed lineups after the refresh.
      // Players from these teams are NOT filtered for "not in lineup" — non-starters may appear.
      {
        const poolTeams = new Set(STATE.POOL.filter(p => !rp(p, 'P')).map(p => p.team).filter(Boolean));
        const confirmedTeams = new Set();
        Object.values(STATE.confirmedLineups).forEach(g => {
          if (g.homeOrder?.length > 0) confirmedTeams.add(g.homeTeam);
          if (g.awayOrder?.length > 0) confirmedTeams.add(g.awayTeam);
        });
        const unconfirmedTeams = [...poolTeams].filter(t => !confirmedTeams.has(t)).sort();
        if (unconfirmedTeams.length > 0 && poolTeams.size > 0) {
          showToast(`⚠ Lineup not yet posted for: ${unconfirmedTeams.join(', ')} — non-starters from these teams may appear in your portfolio.`, 'warn', 9000);
        }
      }

      const ctx = getEngineContext();
      ctx.contestSize = portContestSize;

      // Pool diagnostics after lineup refresh
      {
        const raw = STATE.POOL;
        const calibrated = getCalibratedPool();
        const filteredOut = raw.length - calibrated.length;
        dlog('[Portfolio] raw pool=%d calibrated=%d filtered=%d', raw.length, calibrated.length, filteredOut);
        const noProjection = calibrated.filter(p => !p.median && !p.ceiling && !p.avgPpg);
        if (noProjection.length) dlog('[Portfolio] %d players in pool with no projection (median=ceiling=avgPpg=0): %s',
          noProjection.length, noProjection.slice(0,5).map(p=>p.name).join(', '));
        const pitchers = calibrated.filter(p => rp(p, 'P'));
        const batters  = calibrated.filter(p => !rp(p, 'P'));
        dlog('[Portfolio] pitchers=%d batters=%d stacks3=%d stacks5=%d',
          pitchers.length, batters.length, STATE.STACKS3?.length || 0, STATE.STACKS5?.length || 0);
        if (pitchers.length < 4) console.warn('[Portfolio] Only %d projected pitchers — exposure caps will be hit early', pitchers.length);
      }

      // ── Showdown portfolio path ────────────────────────────────────────────
      if (isShowdown()) {
        // Guard: verify pool actually has Showdown flags; fall back to classic if not
        const calibratedPool = getCalibratedPool();
        const hasCpt = calibratedPool.some(p => p.isCpt);
        if (!hasCpt) {
          console.warn('[Portfolio] isShowdown() is true but pool has no CPT players — falling back to classic builder.');
          STATE.slateType = 'classic';
          updateShowdownIndicator();
          // Fall through to classic path below
        } else {
          ctx.minImpliedTotal = 0; ctx.minGameTotal = 0;
          const sdMinSalaryRaw = document.getElementById('port-min-salary')?.value;
          // Showdown: respect the UI field if set; blank = no floor (0).
          // A hard-coded default here silently rejects lineups on thin/low-salary pools.
          const sdMinSalary = sdMinSalaryRaw !== '' && sdMinSalaryRaw != null ? parseFloat(sdMinSalaryRaw) : 0;
          const sdResult = await Engine.buildShowdownPortfolio(calibratedPool, {
            numLineups, maxExposure, contestType,
            maxOverlap: maxOverlapVal,
            playerExposureOverrides: playerOverrides,
            minSalary: sdMinSalary,
            context: ctx,
          }, pct => { btn.textContent = `Generating... ${Math.round(pct * 100)}%`; });
          STATE.portfolioLineups = sdResult.lineups;
          const total = sdResult.lineups.length || 1;
          const playerExposure = {};
          Object.entries(sdResult.exposureCounts).forEach(([name, count]) => {
            const player = STATE.POOL.find(p => p.name === name);
            playerExposure[name] = {
              count,
              pct: parseFloat((count / total * 100).toFixed(1)),
              cptCount: sdResult.cptCounts[name] || 0,
              flexCount: sdResult.flexCounts[name] || 0,
              isPitcher: player ? Engine.rp(player, 'P') : false,
            };
          });
          STATE.portfolioExposure = playerExposure;
          renderPortfolioResults({
            lineups: sdResult.lineups,
            playerExposure,
            totalLineups: sdResult.lineups.length,
            requested: sdResult.requested,
            _diag: sdResult._diag,
            exposureRelaxUsed: sdResult.exposureRelaxUsed,
          });
          return;
        }
      }

      // ── Classic portfolio path ─────────────────────────────────────────────
      ctx.minImpliedTotal = parseFloat(document.getElementById('port-min-implied')?.value) || 0;
      ctx.minGameTotal = parseFloat(document.getElementById('port-min-game-total')?.value) || 0;
      ctx.maxOppK9 = parseFloat(document.getElementById('port-max-opp-k9')?.value) || 0;
      ctx.blockNegWeather = document.getElementById('port-block-neg-weather')?.checked || false;
      // Fix 3/8: read maxGameExposure from UI field (falls back to engine default 0.65).
      // UI stores it as a whole-number percent; convert to the 0–1 fraction the engine expects.
      const maxGameExposureRaw = parseFloat(document.getElementById('port-max-game-exposure')?.value);
      const maxGameExposure = !isNaN(maxGameExposureRaw) ? maxGameExposureRaw / 100 : 0.65;
      const minSalaryRaw = document.getElementById('port-min-salary')?.value;
      // Blank → undefined so buildPortfolio's 48500 default floor applies.
      // (Passing 0 would override the default and disable the floor entirely.)
      const minSalary = minSalaryRaw !== '' && minSalaryRaw != null ? parseFloat(minSalaryRaw) : undefined;
      // SP-pair concentration cap: max lineups sharing the same two-pitcher combo (0 = off).
      const maxSpPairLineups = parseInt(document.getElementById('port-max-sp-pair')?.value) || 0;
      const result = await buildPortfolioWorker(getCalibratedPool(), {
        numLineups, maxExposure, maxExposurePitcher, contestType, contestSize: portContestSize,
        maxOverlap: maxOverlapVal,
        allowBvP,
        playerOverrides, teamExposureOverrides: teamOverrides, stackPct5, stackSize,
        stacks3: STATE.STACKS3, stacks5: STATE.STACKS5,
        lockedTeams, bannedTeams,
        context: ctx, iterations: OPTIMIZER_ITERATIONS,
        simFilter, simFilterPct, simFilterSims, payoutType, simROIMin, simROIMax,
        maxGameExposure, minSalary, maxSpPairLineups,
        bbEnabled, bbMinOppImplied, bbTarget, secondaryStack,
        ownershipLambda, maxAvgOwnership,
        customPayoutConfig,
      }, (built, target) => {
        let phase;
        if (built < 0) {
          phase = `Filtering ${-built}/${target} lineups…`;
        } else if (simFilter && built >= numLineups) {
          phase = 'Filtering by Sim ROI…';
        } else {
          phase = `${built}/${target}`;
        }
        btn.textContent = `Generating... ${phase}`;
      }, { corrScale: 1.0, simDiversity: 1.0 });

      // Phase 3: Apply best plays automation constraints
      if (STATE.lastBestPlays && STATE.bestPlaysContext) {
        const contrarianTeam = STATE.lastBestPlays.gpp?.contrarianStack?.team;
        const contrarianPlayers = STATE.lastBestPlays.gpp?.contrarianStack?.top5 || [];
        const bringBackPlayers = STATE.lastBestPlays.gpp?.bringBack?.entries || [];

        // Enforce contrarian stack in GPP lineups
        if (enforceContrarian && contestType === 'gpp' && contrarianTeam && contrarianPlayers.length > 0) {
          let contrarianSuccessCount = 0;
          let contrarianFailCount = 0;
          result.lineups = result.lineups.map(lu => {
            if (!lu) return lu;
            const hasContrarian = lu.some(p => contrarianPlayers.some(cp => cp.p.name === p.name));
            if (!hasContrarian) {
              const newLu = Engine.enforceContrarianStack(lu, contrarianTeam, contrarianPlayers.map(p => p.p), getCalibratedPool(), ctx);
              // Check if injection actually placed a contrarian player
              const injected = newLu && newLu.some(p => contrarianPlayers.some(cp => cp.p.name === p.name));
              if (injected) {
                // Roll back if injection reduced the primary stack below the forced stack size
                if (stackSize != null) {
                  const teamCts = {};
                  newLu.forEach(p => { if (p && !rp(p, 'P')) teamCts[p.team] = (teamCts[p.team] || 0) + 1; });
                  if (Math.max(0, ...Object.values(teamCts)) < stackSize) { contrarianFailCount++; return lu; }
                }
                contrarianSuccessCount++; return newLu;
              }
              else { contrarianFailCount++; return lu; }
            } else {
              contrarianSuccessCount++;
              return lu;
            }
          });
          result.contrarianStats = {
            requested: result.lineups.length,
            success: contrarianSuccessCount,
            failed: contrarianFailCount,
          };
        }

        // Enforce bring-back inclusion target
        if (bringBackTargetPct > 0 && bringBackPlayers.length > 0) {
          // Snapshot lineups before modification so we can restore any that now violate stackSize
          const preInjection = stackSize != null ? result.lineups.map(lu => lu ? [...lu] : lu) : null;
          result.lineups = Engine.enforcePlayInclusionTarget(
            result.lineups,
            bringBackPlayers.map(p => p.p.name),
            bringBackTargetPct,
            getCalibratedPool()
          );
          if (preInjection) {
            result.lineups.forEach((lu, i) => {
              if (!lu) return;
              const teamCts = {};
              lu.forEach(p => { if (p && !rp(p, 'P')) teamCts[p.team] = (teamCts[p.team] || 0) + 1; });
              if (Math.max(0, ...Object.values(teamCts)) < stackSize) result.lineups[i] = preInjection[i];
            });
          }
        }

        // Analyze portfolio diversity if enabled
        if (showDiversityAnalysis) {
          const diversity = Engine.analyzePortfolioDiversity(result.lineups, STATE.bestPlaysContext);
          result.diversityAnalysis = diversity;
        }
      }

      STATE.portfolioLineups = result.lineups;
      STATE.portfolioExposure = result.playerExposure;

      // Tool 3: Portfolio run receipt — one structured object summarising the run.
      // Emitted to console as a collapsed group so it's always visible without flooding.
      (() => {
        const diag = result._diag || {};
        const elapsed = Date.now() - _portStartMs;
        const complete = result.lineups.filter(lu => lu && lu.every(Boolean));
        const incomplete = result.lineups.filter(lu => lu && lu.some(p => !p));
        const avgSal = complete.length
          ? Math.round(complete.reduce((s, lu) => s + lu.reduce((ss, p) => ss + (p?.salary || 0), 0), 0) / complete.length)
          : 0;
        const avgMed = complete.length
          ? (complete.reduce((s, lu) => s + lu.reduce((ss, p) => ss + (p?.median || 0), 0), 0) / complete.length).toFixed(1)
          : 0;

        const receipt = {
          requested:   result.requested || result.lineups.length,
          generated:   result.lineups.length,
          complete:    complete.length,
          incomplete:  incomplete.length,
          avgSalary:   `$${avgSal.toLocaleString()}`,
          avgMedian:   `${avgMed} pts`,
          elapsedMs:   elapsed,
          rejections: {
            nullLineup:    diag.nullLu        || 0,
            incompleteSlot:diag.incompleteLu  || 0,
            wrongStackSize:diag.stackSizeFail || 0,
            duplicate:     diag.dupFail       || 0,
            tooSimilar:    diag.overlapFail   || 0,
            gameCap:       diag.gameCapFail   || 0,
            salaryFail:    diag.salaryFail    || 0,
          },
          incompleteSlotPatterns: diag.incompleteSlotPatterns || null,
          ownershipFlags: (STATE.ownershipFlags || []).map(f => `${f.name} ${f.uploadedOwn}%→${f.projectedOwn}%`),
          poolSize:    (STATE.POOL || []).length,
          projCount:   (STATE.POOL || []).filter(p => (p.median || 0) > 0).length,
        };
        STATE.lastPortfolioReceipt = { ...receipt, generated: complete.length };

        const warn = receipt.incomplete > 0 || receipt.rejections.incompleteSlot > 0;
        const label = warn
          ? '%c[mlbdfs] Portfolio receipt ⚠'
          : '%c[mlbdfs] Portfolio receipt ✓';
        const style = warn ? 'font-weight:bold;color:#f5a623' : 'font-weight:bold;color:#4a9eff';
        console.groupCollapsed(label, style);
        console.table(receipt.rejections);
        console.log('generated', receipt.generated, '/', receipt.requested,
          `| avg salary ${receipt.avgSalary} | avg median ${receipt.avgMedian} | ${receipt.elapsedMs}ms`);
        if (receipt.incompleteSlotPatterns) console.log('incomplete slot patterns:', receipt.incompleteSlotPatterns);
        if (receipt.ownershipFlags.length) console.log('ownership flags:', receipt.ownershipFlags.join(', '));
        console.groupEnd();
      })();

      renderPortfolioResults(result);
    } catch (e) {
      console.error('Portfolio generation failed:', e);
      showToast('Portfolio generation failed: ' + e.message, 'warn', 5000);
    } finally {
      btn.textContent = 'Generate Portfolio'; btn.disabled = false;
    }
  });
}

function renderPortfolioResults(result) {
  // Persist full result so applySwap can re-render with all diagnostic fields intact
  STATE.lastPortfolioResult = result;
  const el = document.getElementById('portfolio-results');
  if (!result.lineups.length) {
    const d = result._diag || {};
    const diagParts = [];
    if (d.nullLu) diagParts.push(`${d.nullLu} null (stack placement failed)`);
    if (d.incompleteLu) diagParts.push(`${d.incompleteLu} incomplete (empty roster slots)`);
    if (d.stackSizeFail) diagParts.push(`${d.stackSizeFail} wrong stack size`);
    if (d.dupFail) diagParts.push(`${d.dupFail} duplicates`);
    if (d.overlapFail) diagParts.push(`${d.overlapFail} too similar`);
    if (d.gameCapFail) diagParts.push(`${d.gameCapFail} game cap hits${d.gameCapRelaxed ? ` (relaxed to ${d.gameCapRelaxed}%)` : ''}`);
    const diagStr = diagParts.length ? `<br><span style="font-size:11px;color:var(--tt)">Rejection breakdown: ${diagParts.join(' · ')}</span>` : '';
    const simBandActive = document.getElementById('port-sim-filter')?.checked
      && ((document.getElementById('port-sim-roi-min')?.value || '') !== '' || (document.getElementById('port-sim-roi-max')?.value || '') !== '');
    const simBandHint = simBandActive
      ? '<br><span style="font-size:11px;color:var(--tt)">Sim ROI band is enabled. If the band is too tight, widen ROI min/max (or clear one bound) and regenerate.</span>'
      : '';
    const msg = isShowdown()
      ? 'No valid showdown lineups generated. Ensure the DK showdown salary file is loaded (CPT/FLEX players). Check the browser console for details.'
      : 'No valid lineups generated. Check your player pool and settings — pitcher exposure cap may be too low for the slate size.';
    el.innerHTML = `<div class="ib warn">${msg}${diagStr}${simBandHint}</div>`;
    return;
  }

  const avgSalary = result.lineups.reduce((s, lu) => s + lu.reduce((ss, p) => ss + (p?.salary || 0), 0), 0) / result.lineups.length;
  const avgMedian = result.lineups.reduce((s, lu) => s + lu.reduce((ss, p) => ss + (p?.median || 0), 0), 0) / result.lineups.length;

  let html = '';

  // Warn when fewer lineups were built than requested
  if (result.requested && result.lineups.length < result.requested) {
    const d = result._diag || {};
    const parts = [];
    if (d.overlapFail) parts.push(`${d.overlapFail} too similar (raise Max Overlap)`);
    if (d.nullLu) parts.push(`${d.nullLu} stack placement failed`);
    if (d.stackSizeFail) parts.push(`${d.stackSizeFail} wrong stack size`);
    if (d.dupFail) parts.push(`${d.dupFail} duplicates${d.exhausted ? ' (space exhausted)' : ''}`);
    if (d.incompleteLu) parts.push(`${d.incompleteLu} incomplete`);
    if (d.gameCapFail) parts.push(`${d.gameCapFail} game cap hits${d.gameCapRelaxed ? ` (auto-relaxed to ${d.gameCapRelaxed}%)` : ' (raise Max Game Exposure)'}`);
    const why = parts.length ? ` — rejections: ${parts.join(', ')}` : '';
    html += `<div class="ib warn" style="margin-bottom:8px"><strong>Only ${result.lineups.length} of ${result.requested} lineups generated${why}.</strong></div>`;

    // Context-aware "how to fix it" tips
    const tipsList = [];
    const stackSizeOpt = result.stackSize; // 3 | 4 | 5 | null
    const avail5 = STATE.STACKS5.length;
    const avail3 = STATE.STACKS3.length;
    const short = result.requested - result.lineups.length;

    if (stackSizeOpt === 5) {
      if (avail5 < result.requested) {
        const minNeeded = Math.ceil(result.requested / 4);
        tipsList.push(`<strong>Load more 5-man stacks</strong> — you have ${avail5} but ideally need at least ${minNeeded} stacks to generate ${result.requested} unique lineups. Add more team/player combinations to your 5-man stacks file.`);
      }
      if (d.stackSizeFail > 5) {
        tipsList.push(`${d.stackSizeFail} attempts produced a stack smaller than 5-man. Make sure every row in your 5-man stacks file has 5 distinct batters that exist in the player CSV.`);
      }
    } else if (stackSizeOpt === 3 && d.stackSizeFail > 5) {
      tipsList.push(`${d.stackSizeFail} attempts produced a stack smaller than 3-man — verify your 3-man stacks file (${avail3} loaded) and that all named players are in the CSV.`);
    }

    if (d.overlapFail > 20) {
      const curOverlap = parseInt(document.getElementById('port-max-overlap')?.value) || 0;
      const suggested = curOverlap === 0 ? 5 : Math.min(9, curOverlap + 2);
      const autoNote = d.overlapRelaxed ? ` (auto-raised to ${d.overlapRelaxed} during generation)` : '';
      tipsList.push(`<strong>Raise Max Overlap</strong> — ${d.overlapFail} lineups were rejected for too many shared players${autoNote}. Try setting it to ${suggested}.`);
    }

    if (d.dupFail > 10 && !d.exhausted) {
      const curExp = parseInt(document.getElementById('port-max-exposure')?.value) || 60;
      const suggested = Math.min(100, curExp + 10);
      tipsList.push(`<strong>Raise Max Exposure %</strong> — ${d.dupFail} exact-duplicate lineups were rejected because players hit their cap too early. Try raising exposure to ${suggested}%.`);
    }

    if (d.nullLu > result.requested && stackSizeOpt != null) {
      tipsList.push(`${d.nullLu} stack placement attempts returned null — verify that the player names in your ${stackSizeOpt}-man stacks file exactly match names in the player CSV.`);
    }

    // Mix mode with high 5-man failure rate: explain thin-team batter depth
    if (d.nullLu > 20 && stackSizeOpt == null) {
      if (d.thinTeams && d.thinTeams.length > 0) {
        tipsList.push(`<strong>${d.nullLu} 5-man stack attempts failed</strong> — ${d.thinTeams.length} team(s) don't have enough projectable batters to form a 5-man stack: <strong>${d.thinTeams.join(', ')}</strong>. The engine falls back to 3-man for these teams. Consider lowering 5-Man Stack % or loading projections for those teams.`);
      } else {
        tipsList.push(`<strong>${d.nullLu} stack placement attempts failed</strong> — some teams may not have enough projectable batters for a 5-man stack, or all their stacks were already used. Try lowering 5-Man Stack % from 100% (e.g. to 60–70%) to allow 3-man fallbacks more often.`);
      }
    }

    if (d.gameCapFail > 5 && !d.gameCapRelaxed) {
      const curGE = parseFloat(document.getElementById('port-max-game-exposure')?.value) / 100 || 0.65;
      const suggested = Math.min(1.0, curGE + 0.15);
      tipsList.push(`<strong>Raise Max Game Exposure</strong> — ${d.gameCapFail} lineups were blocked by the game cap (${Math.round(curGE * 100)}%). Other games don't have enough valid lineups to fill the slate. Try raising it to ${Math.round(suggested * 100)}%.`);
    } else if (d.gameCapFail > 5 && d.gameCapRelaxed) {
      tipsList.push(`Game cap was automatically relaxed to ${d.gameCapRelaxed}% to reach the lineup target — other games couldn't supply enough unique lineups. Consider raising Max Game Exposure manually.`);
    }

    if (d.exhausted) {
      tipsList.push(`<strong>Unique lineup space exhausted</strong> — the engine found all ${result.lineups.length} valid combinations given your current stacks and exposure settings. To generate more: add more stacks entries, raise Max Exposure %, or (if using forced stack size) try 3-man instead of 5-man stacks.`);
    }

    const curExpMain = parseInt(document.getElementById('port-max-exposure')?.value) || 60;
    if (!d.exhausted && curExpMain < 40 && short > 3) {
      tipsList.push(`Max Exposure is set to ${curExpMain}% — this is quite restrictive for ${result.requested} lineups. Raising it to 50–60% gives the engine more valid combinations.`);
    }

    if (result.simFilterStats?.inBand === 0) {
      tipsList.push('<strong>0 candidates met your ROI band</strong> — final lineups were fully backfilled from outside the band. Widen ROI bounds (or clear one bound) and/or increase Overflow %.');
    }

    if (tipsList.length) {
      html += `<div class="ib blue" style="margin-bottom:8px;font-size:12px"><strong>To reach ${result.requested} lineups, try:</strong><ul style="margin:6px 0 2px 18px;padding:0">${tipsList.map(t => `<li style="margin-bottom:4px">${t}</li>`).join('')}</ul></div>`;
    }
  }

  // Post-generation warnings (virtual stacks, pitcher cap overruns)
  const postWarnings = [];
  if (result.exposureRelaxUsed > 0) {
    const relaxPct = Math.round(result.exposureRelaxUsed / (result.requested || 20) * 100);
    let breachStr = '';
    if (Array.isArray(result.exposureCapBreached) && result.exposureCapBreached.length > 0) {
      const top = result.exposureCapBreached.slice(0, 5).map(b =>
        `<strong>${esc(b.name)}</strong> ${b.pct}% (cap ${b.originalCapPct}%)`
      ).join(', ');
      const extra = result.exposureCapBreached.length > 5 ? ` +${result.exposureCapBreached.length - 5} more` : '';
      breachStr = `<br><span style="font-size:11px">Players over stated cap: ${top}${extra}.</span>`;
    }
    postWarnings.push(`<strong>Exposure caps were relaxed by ${result.exposureRelaxUsed} appearance${result.exposureRelaxUsed > 1 ? 's' : ''} (+${relaxPct}%) to fill all lineups.</strong>${breachStr}<br><span style="font-size:11px">To avoid this: add more stacks, raise Max Exposure %, or reduce lineup count.</span>`);
  }
  if (result.minSalaryRelaxed) {
    const r = result.minSalaryRelaxed;
    const reach = r.maxReachable ? ` This pool's richest valid lineup is only $${r.maxReachable.toLocaleString()}.` : '';
    postWarnings.push(`<strong>Min-salary floor auto-lowered to $${r.appliedFloor.toLocaleString()}</strong> (you requested $${r.requested.toLocaleString()}).${reach} The requested floor was unreachable for this slate, so it was relaxed to fill the portfolio instead of returning zero lineups. Lower the Min Salary field (or set 0) to silence this.`);
  }
  if (result._diag?.overlapRelaxed && !postWarnings.some(w => w.includes('Overlap'))) {
    postWarnings.push(`<strong>Overlap cap auto-raised to ${result._diag.overlapRelaxed}.</strong> The engine raised the per-pair overlap limit during generation to break a deadlock — some lineups share more players than your stated max. Raise Max Overlap manually to silence this warning.`);
  }
  if (result._diag?.gameCapRelaxed) {
    postWarnings.push(`<strong>Game exposure cap auto-raised to ${result._diag.gameCapRelaxed}%.</strong> Other games couldn't supply enough unique lineups. To avoid this, lower lineup count or raise Max Game Exposure manually.`);
  }
  if (result.virtualStackTeams?.length) {
    postWarnings.push(`<strong>Virtual stacks used for:</strong> ${result.virtualStackTeams.map(t => esc(t)).join(', ')} — no stacks file entry found; top batters were auto-selected.`);
  }
  if (result.pitcherWarnings?.length) {
    postWarnings.push(`<strong>Pitcher cap exceeded:</strong> ${result.pitcherWarnings.map(w => `${esc(w.name)} (${w.pct}%)`).join(', ')} — not enough viable pitchers to stay within the cap.`);
  }
  if (result.stackShortfallCount > 0 && result.stackSize != null) {
    const pct = Math.round(result.stackShortfallCount / result.totalLineups * 100);
    postWarnings.push(`<strong>${result.stackShortfallCount} lineup${result.stackShortfallCount > 1 ? 's' : ''} (${pct}%) did not achieve the forced ${result.stackSize}-man stack</strong> — only ${result.stackSize - 1} batters from one team were placed. This happens when one stack player is exposure-capped or salary-constrained. To fix: add more stacks, raise Max Exposure, or switch to Mix mode.`);
  }
  // CPT concentration warning (showdown only): single-captain dominance = high single-player downside
  if (isShowdown() && result.playerExposure && result.totalLineups > 0) {
    const cptHeavy = Object.entries(result.playerExposure)
      .filter(([, d]) => (d.cptCount || 0) / result.totalLineups > 0.40)
      .sort(([, a], [, b]) => (b.cptCount || 0) - (a.cptCount || 0));
    if (cptHeavy.length) {
      const names = cptHeavy.map(([nm, d]) => `<strong>${esc(nm)}</strong> (${Math.round(d.cptCount / result.totalLineups * 100)}% CPT)`).join(', ');
      postWarnings.push(`<strong>High captain concentration:</strong> ${names} — concentrated CPT exposure amplifies downside if this player underperforms. Consider adding more captain variety or raising Max Exposure % to allow other players to captain.`);
    }
  }
  if (result.bannedTeams?.length) {
    postWarnings.push(`Banned teams excluded: <strong>${result.bannedTeams.map(esc).join(', ')}</strong>`);
  }
  if (result.lockedTeams?.length) {
    postWarnings.push(`Locked teams rotated: <strong>${result.lockedTeams.map(esc).join(', ')}</strong>`);
  }
  if (result.teamExposureWarnings?.length) {
    postWarnings.push(`<strong>Team stack cap exceeded:</strong> ${result.teamExposureWarnings.map(w => `${esc(w.team)} (${w.pct}% vs ${w.cap}% cap)`).join(', ')} — not enough viable lineups to stay within the cap.`);
  }
  if (postWarnings.length) {
    html += postWarnings.map(w => `<div class="ib blue" style="margin-bottom:6px;font-size:12px">${w}</div>`).join('');
  }

  // Contrarian injection warning: shown when Phase 3 enforcement failed for some lineups.
  if (result.contrarianStats && result.contrarianStats.failed > 0) {
    const cs = result.contrarianStats;
    const failPct = Math.round(cs.failed / cs.requested * 100);
    html += `<div class="ib" style="margin-bottom:6px;font-size:12px;border-color:var(--brd-w)">
      <strong>Contrarian Injection:</strong> ${cs.success}/${cs.requested} lineups injected successfully · <strong style="color:var(--tw)">${cs.failed} failed (${failPct}%)</strong> — salary or exposure constraints blocked replacement. Lower Min Salary or raise Max Exposure to improve coverage.
    </div>`;
  }

  // Bring-back rate summary (GPP only): shows the actual placement rate so users can
  // diagnose when salary constraints or exposure caps are blocking bring-back batters.
  const contestTypeForBB = document.getElementById('port-contest-type')?.value;
  if (contestTypeForBB === 'gpp' && result.bringBackCount != null && result.totalLineups > 0) {
    const bbPct = Math.round(result.bringBackCount / result.totalLineups * 100);
    const bbColor = bbPct >= 70 ? 'var(--tsu)' : bbPct >= 40 ? 'var(--ti)' : 'var(--tw)';
    const bbNote = bbPct < 40
      ? ' — low bring-back rate. Check salary headroom or raise Min Opp Implied.'
      : bbPct < 70 ? ' — moderate. Consider lowering Min Opp Implied to allow more bring-backs.' : '';
    html += `<div style="margin-bottom:6px;padding:6px 10px;background:var(--bs);border-radius:var(--r);border:0.5px solid var(--brd-s);font-size:12px">
      <strong>Bring-Back Rate:</strong> <span style="color:${bbColor};font-weight:700">${result.bringBackCount}/${result.totalLineups} lineups (${bbPct}%)</span>${esc(bbNote)}
    </div>`;
  }

  // Sim filter transparency block — shows how many lineups hit the band vs were backfilled
  if (result.simFilterStats) {
    const sf = result.simFilterStats;
    const bandSet = sf.inBand != null;
    const backfillPct = sf.generated > 0 ? Math.round(sf.backfilled / result.totalLineups * 100) : 0;
    const bandColor = sf.backfilled === 0 ? 'var(--tsu)' : sf.backfilled < result.totalLineups * 0.25 ? 'var(--ti)' : 'var(--tw)';
    const roiRange = (sf.simROIMin != null && sf.simROIMax != null)
      ? ` · ROI range: ${sf.simROIMin >= 0 ? '+' : ''}${sf.simROIMin}% to ${sf.simROIMax >= 0 ? '+' : ''}${sf.simROIMax}%`
      : '';
    const meanStr = sf.simROIMean != null ? ` · avg ${sf.simROIMean >= 0 ? '+' : ''}${sf.simROIMean}%` : '';
    const bandStr = bandSet
      ? `${sf.inBand} of ${sf.generated} candidates met band · <strong style="color:${bandColor}">${sf.backfilled} backfilled</strong> (${backfillPct}%)`
      : `Top ${result.totalLineups} of ${sf.generated} candidates by sim ROI`;
    const zeroBandWarn = bandSet && sf.inBand === 0
      ? '<br><span style="color:var(--tw)">⚠ 0 candidates met your ROI band. All selected lineups were backfilled from outside the band — widen ROI bounds or increase Overflow %.</span>'
      : '';
    html += `<div class="ib" style="margin-bottom:6px;font-size:12px;border-color:var(--brd-s)">
      <strong>Sim ROI Filter:</strong> ${bandStr}${roiRange}${meanStr}
      ${zeroBandWarn}
      ${sf.backfilled > result.totalLineups * 0.25 ? '<br><span style="color:var(--tw)">⚠ More than 25% of lineups were backfilled outside your ROI band — consider widening the band or increasing Overflow %.</span>' : ''}
    </div>`;
  }

  const div = result.diversity || Engine.computePortfolioDiversity(result.lineups);
  const divColor = div.score >= 50 ? 'var(--tsu)' : div.score >= 35 ? 'var(--tw)' : 'var(--td)';
  const ovlpColor = div.maxOverlap > 7 ? 'var(--tw)' : 'var(--tsu)';

  // Diversity histogram: bars for each overlap bucket 0–10
  const maxDivPairs = Math.max(...Object.values(div.distribution || {}), 1);
  const divBars = Array.from({ length: 11 }, (_, k) => {
    const count = div.distribution?.[k] || 0;
    const w = Math.round(count / maxDivPairs * 40);
    const barColor = k <= 4 ? 'var(--tsu)' : k <= 6 ? 'var(--tw)' : 'var(--td)';
    return `<div style="display:flex;align-items:center;gap:3px;font-size:9px;line-height:1.3">
      <span style="width:12px;text-align:right;color:var(--tt)">${k}</span>
      <div style="width:${w}px;height:5px;border-radius:2px;background:${barColor};min-width:${count?2:0}px"></div>
      ${count ? `<span style="color:var(--ts)">${count}</span>` : ''}
    </div>`;
  }).join('');

  const maxGamePct = Math.round((div.maxGameExposurePct || 0) * 100);
  const maxGameColor = maxGamePct >= 70 ? 'var(--td)' : maxGamePct >= 55 ? 'var(--tw)' : 'var(--tsu)';
  // Most-exposed game label: find the game key with highest count
  const topGameEntry = Object.entries(div.gameExposure || {}).sort((a, b) => b[1] - a[1])[0];
  const topGameLabel = topGameEntry ? esc(topGameEntry[0]) : '—';

  html += `<div class="mc-row">
    <div class="mc"><div class="mc-l">Lineups</div><div class="mc-v">${result.totalLineups}</div></div>
    <div class="mc"><div class="mc-l">Avg Salary</div><div class="mc-v">$${Math.round(avgSalary).toLocaleString()}</div></div>
    <div class="mc"><div class="mc-l">Avg Median</div><div class="mc-v">${avgMedian.toFixed(1)}</div></div>
    <div class="mc"><div class="mc-l">Unique Players</div><div class="mc-v">${Object.keys(result.playerExposure).length}</div></div>
    <div class="mc" title="Diversity = (10 − avg shared players) / 10. Higher = less correlated portfolio.">
      <div class="mc-l">Diversity</div>
      <div class="mc-v" style="color:${divColor}">${div.score}%</div>
      <div class="mc-s">avg ${div.avgOverlap} shared</div>
    </div>
    <div class="mc" title="Most players shared between any two lineups in the portfolio.">
      <div class="mc-l">Max Overlap</div>
      <div class="mc-v" style="color:${ovlpColor}">${div.maxOverlap}</div>
      <div class="mc-s">players</div>
    </div>
    <div class="mc" title="% of lineups whose primary stack is concentrated in the single most-used game. Above 70% means over-exposure to one game outcome.">
      <div class="mc-l">Game Conc.</div>
      <div class="mc-v" style="color:${maxGameColor}">${maxGamePct}%</div>
      <div class="mc-s">${topGameLabel}</div>
    </div>
  </div>
  <div style="margin:8px 0 4px;font-size:10px;color:var(--tt);letter-spacing:.05em">OVERLAP DISTRIBUTION (shared players per lineup pair)</div>
  <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">${divBars}</div>
  ${div.score < 35 ? `<div class="ib warn" style="font-size:11px;margin-bottom:8px">Low diversity (${div.score}%) — consider lowering Max Lineup Overlap below ${div.maxOverlap} to spread variance across your portfolio.</div>` : ''}
  ${maxGamePct >= 70 ? `<div class="ib warn" style="font-size:11px;margin-bottom:8px">High game concentration (${maxGamePct}% in ${topGameLabel}) — if this game is rained out or goes low-scoring, most of your portfolio is at risk. Consider locking a second game's stack.</div>` : ''}`;

  // Phase 3: Render best plays diversity analysis if available
  if (result.diversityAnalysis) {
    const da = result.diversityAnalysis;
    const leverageBarHtml = `<div style="display:flex;align-items:center;gap:4px;font-size:11px">
      <div style="width:80px;height:6px;background:var(--bs);border-radius:2px;overflow:hidden">
        <div style="width:${da.leveragePct}%;height:6px;background:var(--tsu)"></div>
      </div>
      <span style="color:var(--ti)">${da.withLeverage}/${da.total} lineups (${da.leveragePct}%) | avg ${da.avgLeverageCount} plays/lu</span>
    </div>`;
    
    const contrarianBarHtml = `<div style="display:flex;align-items:center;gap:4px;font-size:11px">
      <div style="width:80px;height:6px;background:var(--bs);border-radius:2px;overflow:hidden">
        <div style="width:${da.contrarianPct}%;height:6px;background:var(--tw)"></div>
      </div>
      <span style="color:var(--ti)">${da.withContrarian}/${da.total} lineups (${da.contrarianPct}%) | avg ${da.avgContrarianCount} plays/lu</span>
    </div>`;
    
    const bringBackBarHtml = `<div style="display:flex;align-items:center;gap:4px;font-size:11px">
      <div style="width:80px;height:6px;background:var(--bs);border-radius:2px;overflow:hidden">
        <div style="width:${da.bringBackPct}%;height:6px;background:var(--tb)"></div>
      </div>
      <span style="color:var(--ti)">${da.withBringBack}/${da.total} lineups (${da.bringBackPct}%) | avg ${da.avgBringBackCount} plays/lu</span>
    </div>`;
    
    const chalkBarHtml = `<div style="display:flex;align-items:center;gap:4px;font-size:11px">
      <div style="width:80px;height:6px;background:var(--bs);border-radius:2px;overflow:hidden">
        <div style="width:${da.chalkPct}%;height:6px;background:var(--ts)"></div>
      </div>
      <span style="color:var(--ti)">${da.withChalk}/${da.total} lineups (${da.chalkPct}%) | avg ${da.avgChalkCount} plays/lu</span>
    </div>`;

    html += `<div style="margin-top:12px;padding:10px 12px;background:var(--bs);border-radius:var(--r);border:0.5px solid var(--brd-s)">
      <div style="margin-bottom:8px;font-size:12px;font-weight:600;color:var(--ti)">📊 Best Plays Distribution</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <div>
          <div style="font-size:11px;color:var(--tp);margin-bottom:3px;font-weight:500">⚡ Leverage</div>
          ${leverageBarHtml}
        </div>
        <div>
          <div style="font-size:11px;color:var(--tp);margin-bottom:3px;font-weight:500">🏃 Contrarian</div>
          ${contrarianBarHtml}
        </div>
        <div>
          <div style="font-size:11px;color:var(--tp);margin-bottom:3px;font-weight:500">🔄 Bring-Back</div>
          ${bringBackBarHtml}
        </div>
        <div>
          <div style="font-size:11px;color:var(--tp);margin-bottom:3px;font-weight:500">💰 Chalk (lower is better)</div>
          ${chalkBarHtml}
        </div>
      </div>
    </div>`;
  }

  // Separate pitcher and batter exposure tables
  const allEntries = Object.entries(result.playerExposure).sort((a, b) => b[1].count - a[1].count);
  const pitcherEntries = allEntries.filter(([, d]) => d.isPitcher);
  const batterEntries = allEntries.filter(([, d]) => !d.isPitcher);

  const renderExposureRows = (entries, capPct) => entries.slice(0, 60).map(([name, data]) => {
    const pct = parseFloat(data.pct);
    const overCap = capPct && pct > capPct;
    const barColor = overCap ? 'var(--td)' : pct > 50 ? 'var(--tw)' : 'var(--tsu)';
    return `<tr${overCap ? ' style="background:var(--bd)"' : ''}><td><strong>${esc(name)}</strong>${overCap ? ' <span class="pill pd" style="font-size:9px">over cap</span>' : ''}</td><td>${data.count}</td><td><div style="display:flex;align-items:center;gap:6px"><div style="width:60px;height:5px;border-radius:3px;background:var(--bs);overflow:hidden"><div style="width:${Math.min(pct, 100)}%;height:5px;background:${barColor}"></div></div>${pct}%</div></td></tr>`;
  }).join('');

  const pitcherCap = parseInt(document.getElementById('port-max-pitcher')?.value) || 60;
  const batterCap = parseInt(document.getElementById('port-max-exposure')?.value) || 60;

  // Detect showdown from actual result data: check if any lineup has a CPT player in slot 0.
  // This prevents stale isShowdown() state from showing the wrong exposure columns.
  const resultIsShowdown = isShowdown() && result.lineups.length > 0 &&
    result.lineups[0]?.[0]?.isCpt === true;

  html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px">`;

  if (resultIsShowdown) {
    // Showdown: CPT column = players that appeared in slot 0; FLEX = players in slots 1-5.
    // Use dedicated cptCount/flexCount so the same player doesn't show in both tables.
    const total = result.totalLineups || result.lineups.length || 1;
    const cptEntries = Object.entries(result.playerExposure)
      .filter(([, d]) => (d.cptCount || 0) > 0)
      .map(([name, d]) => [name, { count: d.cptCount, pct: parseFloat((d.cptCount / total * 100).toFixed(1)) }])
      .sort((a, b) => b[1].count - a[1].count);
    const flexEntries = Object.entries(result.playerExposure)
      .filter(([, d]) => (d.flexCount || 0) > 0)
      .map(([name, d]) => [name, { count: d.flexCount, pct: parseFloat((d.flexCount / total * 100).toFixed(1)) }])
      .sort((a, b) => b[1].count - a[1].count);
    html += `<div><div class="sec-label">Captain (CPT) Exposure <span style="font-weight:400;text-transform:none;letter-spacing:0;font-size:10px">(cap: ${batterCap}%)</span></div>
    <div style="max-height:220px;overflow-y:auto"><table><thead><tr><th>Player</th><th>#</th><th>Exp%</th></tr></thead><tbody>
    ${cptEntries.length ? renderExposureRows(cptEntries, batterCap) : '<tr><td colspan="3" style="color:var(--tt)">No CPT data</td></tr>'}
    </tbody></table></div></div>`;
    html += `<div><div class="sec-label">FLEX Exposure <span style="font-weight:400;text-transform:none;letter-spacing:0;font-size:10px">(cap: ${batterCap}%)</span></div>
    <div style="max-height:220px;overflow-y:auto"><table><thead><tr><th>Player</th><th>#</th><th>Exp%</th></tr></thead><tbody>
    ${flexEntries.length ? renderExposureRows(flexEntries, batterCap) : '<tr><td colspan="3" style="color:var(--tt)">No FLEX data</td></tr>'}
    </tbody></table></div></div>`;
  } else {
    html += `<div><div class="sec-label">Pitcher Exposure <span style="font-weight:400;text-transform:none;letter-spacing:0;font-size:10px">(cap: ${pitcherCap}%)</span></div>
    <div style="max-height:220px;overflow-y:auto"><table><thead><tr><th>Pitcher</th><th>#</th><th>Exp%</th></tr></thead><tbody>
    ${pitcherEntries.length ? renderExposureRows(pitcherEntries, pitcherCap) : '<tr><td colspan="3" style="color:var(--tt)">No pitcher data</td></tr>'}
    </tbody></table></div></div>`;
    html += `<div><div class="sec-label">Batter Exposure <span style="font-weight:400;text-transform:none;letter-spacing:0;font-size:10px">(cap: ${batterCap}%)</span></div>
    <div style="max-height:220px;overflow-y:auto"><table><thead><tr><th>Batter</th><th>#</th><th>Exp%</th></tr></thead><tbody>
    ${batterEntries.length ? renderExposureRows(batterEntries, batterCap) : '<tr><td colspan="3" style="color:var(--tt)">No batter data</td></tr>'}
    </tbody></table></div></div>`;
  }

  html += `</div>`;

  // Team stack exposure (classic only)
  if (!resultIsShowdown && result.teamExposure && Object.keys(result.teamExposure).length) {
    html += `<div class="sec-label" style="margin-top:12px">Stack Exposure (3+ batters)</div>
    <div class="chips">${Object.entries(result.teamExposure).sort((a, b) => b[1] - a[1]).map(([team, count]) => {
      const isLocked = result.lockedTeams?.includes(team);
      return `<span class="chip${isLocked ? ' selected' : ''}">${esc(team)}: ${count}/${result.totalLineups} (${(count / result.totalLineups * 100).toFixed(0)}%)${isLocked ? ' 🔒' : ''}</span>`;
    }).join('')}</div>`;
  }

  // CPT exposure (showdown only)
  if (resultIsShowdown) {
    const cptCounts = {};
    result.lineups.forEach(lu => { if (lu[0]) cptCounts[lu[0].name] = (cptCounts[lu[0].name] || 0) + 1; });
    if (Object.keys(cptCounts).length) {
      const total = result.totalLineups || result.lineups.length;
      html += `<div class="sec-label" style="margin-top:12px">Captain Usage</div>
      <div class="chips">${Object.entries(cptCounts).sort((a, b) => b[1] - a[1]).map(([name, count]) =>
        `<span class="chip" style="border-color:rgba(59,130,246,.4)">${esc(name)}: ${count}/${total} (${Math.round(count / total * 100)}%)</span>`
      ).join('')}</div>`;
    }
  }

  // Individual lineups (collapsible)
  const sdMode = isShowdown();
  const luSlots = activeSlots();
  html += `<div class="sec-label" style="margin-top:12px">Lineups <button class="btn" style="font-size:10px;padding:2px 8px" onclick="togglePortfolioLineups()">Show/Hide</button></div>
  <div id="portfolio-lineup-list" style="display:none;max-height:400px;overflow-y:auto">`;
  result.lineups.forEach((lu, idx) => {
    const analysis = Engine.analyzeLineup(lu);
    const stackTeams = analysis?.stacks?.map(s => s.team) || [];
    const lockedHit = result.lockedTeams?.filter(t => stackTeams.includes(t)) || [];
    html += `<div class="sk-card" style="margin-bottom:6px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <strong style="font-size:12px">Lineup #${idx + 1}</strong>
        <span style="font-size:11px;color:var(--ts)">$${analysis?.salary?.toLocaleString() || '?'} / Med: ${analysis?.medianPts?.toFixed(1) || '?'} / Ceil: ${analysis?.ceilingPts?.toFixed(1) || '?'}${lockedHit.length ? ` / 🔒 ${lockedHit.join(',')}` : ''}</span>
      </div>
      <div class="chips">${lu.map((p, i) => {
        if (!p) return '';
        const slotKey = luSlots[i]?.key || '';
        const isCpt = sdMode && slotKey === 'CPT';
        const label = isCpt ? `<strong style="color:#60a5fa">CPT</strong> ` : (sdMode ? '' : `(${esc(p.dkPos)}) `);
        return `<span class="chip" style="${isCpt ? 'border-color:rgba(59,130,246,.5)' : ''}">${label}${esc(p.name)}</span>`;
      }).join('')}</div>
    </div>`;
  });
  html += '</div>';

  html += `<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
    <button class="btn-p" onclick="exportPortfolio()">Export All Lineups CSV</button>
    <button class="btn-g" onclick="savePortfolioToHistory()">Save All to Backtest History</button>
    <button class="btn" onclick="runPortfolioSim()" id="port-sim-btn">Simulate Portfolio (P Threshold)</button>
  </div>
  <div id="port-sim-results" style="margin-top:10px"></div>`;

  el.innerHTML = html;
}

function togglePortfolioLineups() {
  const el = document.getElementById('portfolio-lineup-list');
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

// ── Late Swap ─────────────────────────────────────────────────────────────────
function scanLateSwaps() {
  const statusEl = document.getElementById('late-swap-status');
  const resultsEl = document.getElementById('late-swap-results');
  if (!STATE.portfolioLineups.length) {
    if (statusEl) statusEl.innerHTML = '<span class="pill pw">Generate a portfolio first</span>';
    return;
  }

  // Build set of flagged player names (IL or GTD)
  const flagged = new Set();
  STATE.injuryData.forEach(f => flagged.add(f.name.toLowerCase()));
  // Also flag any pool player marked injured
  STATE.POOL.forEach(p => { if (p.injuryFlag) flagged.add(p.name.toLowerCase()); });

  // Scan each lineup for affected players
  const affected = []; // [{ luIdx, slotIdx, player, slotLabel }]
  STATE.portfolioLineups.forEach((lu, luIdx) => {
    lu.forEach((p, slotIdx) => {
      if (p && flagged.has(p.name.toLowerCase())) {
        affected.push({ luIdx, slotIdx, player: p, slotLabel: DK_SLOTS[slotIdx]?.label || '?' });
      }
    });
  });

  if (!affected.length) {
    if (statusEl) statusEl.innerHTML = '<span class="pill psu">No injured/scratched players found in portfolio</span>';
    if (resultsEl) resultsEl.innerHTML = '';
    return;
  }

  // Group by player for summary
  const byPlayer = {};
  affected.forEach(a => {
    const key = a.player.name;
    if (!byPlayer[key]) byPlayer[key] = { player: a.player, slots: [] };
    byPlayer[key].slots.push(a);
  });

  if (statusEl) statusEl.innerHTML = `<span class="pill pw">${affected.length} slot(s) across ${Object.keys(byPlayer).length} player(s) need swaps</span>`;

  // For each affected slot, find best replacements
  let html = '';
  for (const [name, info] of Object.entries(byPlayer)) {
    const p = info.player;
    const injEntry = STATE.injuryData.find(f => f.name.toLowerCase() === p.name.toLowerCase());
    const injDesc = injEntry ? `${injEntry.type}: ${injEntry.description || ''}` : 'Flagged';
    const lineupNums = info.slots.map(s => '#' + (s.luIdx + 1)).join(', ');

    html += `<div class="sk-card" style="margin-bottom:8px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <div><strong>${esc(p.name)}</strong> <span class="pill pd" style="font-size:10px">${esc(p.dkPos)}</span> <span style="font-size:11px;color:var(--tt)">$${p.salary.toLocaleString()}</span></div>
        <span style="font-size:11px;color:var(--td)">${esc(injDesc)}</span>
      </div>
      <div style="font-size:11px;color:var(--tt);margin-bottom:6px">Affected lineups: ${lineupNums}</div>`;

    // Find eligible replacements for this slot type
    const slotIdx = info.slots[0].slotIdx;
    const slot = DK_SLOTS[slotIdx];
    if (!slot) { html += '</div>'; continue; }

    // Get names already heavily used in portfolio
    const namesInPortfolio = new Set();
    STATE.portfolioLineups.forEach(lu => lu.forEach(lp => { if (lp) namesInPortfolio.add(lp.name); }));

    // Find candidates: eligible for position, not injured, sorted by median desc
    const candidates = STATE.POOL.filter(c =>
      slot.eligible(c) &&
      !flagged.has(c.name.toLowerCase()) &&
      c.name !== p.name &&
      c.median > 0
    ).sort((a, b) => b.median - a.median).slice(0, 8);

    if (candidates.length) {
      html += `<table style="font-size:11px;width:100%"><thead><tr><th>Replacement</th><th>Pos</th><th>Salary</th><th>Median</th><th>Δ Med</th><th>Δ Salary</th><th>Own%</th><th></th></tr></thead><tbody>`;
      candidates.forEach(c => {
        const dMed = c.median - p.median;
        const dSal = c.salary - p.salary;
        const medColor = dMed >= 0 ? 'var(--tsu)' : 'var(--td)';
        const salColor = dSal <= 0 ? 'var(--tsu)' : dSal > 500 ? 'var(--td)' : 'var(--tw)';
        const inPortfolio = namesInPortfolio.has(c.name);
        html += `<tr>
          <td><strong>${esc(c.name)}</strong>${inPortfolio ? ' <span class="pill pg" style="font-size:9px">in port</span>' : ''}</td>
          <td>${esc(c.dkPos)}</td>
          <td>$${c.salary.toLocaleString()}</td>
          <td>${c.median.toFixed(1)}</td>
          <td style="color:${medColor}">${dMed >= 0 ? '+' : ''}${dMed.toFixed(1)}</td>
          <td style="color:${salColor}">${dSal >= 0 ? '+' : ''}$${dSal.toLocaleString()}</td>
          <td>${c.own > 0 ? c.own.toFixed(1) + '%' : '\u2014'}</td>
          <td><button class="btn" style="font-size:10px;padding:1px 6px" onclick="applySwap('${escAttr(p.name)}','${escAttr(c.name)}')">Swap</button></td>
        </tr>`;
      });
      html += '</tbody></table>';
    } else {
      html += '<div style="font-size:11px;color:var(--tt);padding:4px 0">No eligible replacements found.</div>';
    }
    html += '</div>';
  }

  if (resultsEl) resultsEl.innerHTML = html;
}

function applySwap(oldName, newName) {
  const newPlayer = STATE.POOL.find(p => p.name === newName);
  if (!newPlayer) return;

  let swapCount = 0;
  STATE.portfolioLineups.forEach(lu => {
    lu.forEach((p, i) => {
      if (p && p.name === oldName) {
        // Check salary feasibility
        const luSalary = lu.reduce((s, lp) => s + (lp?.salary || 0), 0);
        const newLuSalary = luSalary - p.salary + newPlayer.salary;
        if (newLuSalary <= SALARY_CAP) {
          lu[i] = { ...newPlayer };
          swapCount++;
        }
      }
    });
  });

  if (swapCount > 0) {
    showToast(`Swapped ${oldName} → ${newName} in ${swapCount} lineup${swapCount > 1 ? 's' : ''}`, 'info', 3000);
    // Recompute exposure
    const exp = {};
    STATE.portfolioLineups.forEach(lu => {
      lu.forEach(p => {
        if (!p) return;
        if (!exp[p.name]) exp[p.name] = { count: 0, pct: '0%', isPitcher: rp(p, 'P') };
        exp[p.name].count++;
      });
    });
    const total = STATE.portfolioLineups.length;
    Object.keys(exp).forEach(name => { exp[name].pct = (exp[name].count / total * 100).toFixed(1) + '%'; });
    STATE.portfolioExposure = exp;
    // Spread the full last result to preserve all warning/diagnostic fields; override only what changed
    renderPortfolioResults({
      ...(STATE.lastPortfolioResult || {}),
      lineups: STATE.portfolioLineups,
      playerExposure: STATE.portfolioExposure,
      totalLineups: total,
      diversity: null, // recomputed lazily by renderPortfolioResults
    });
    scanLateSwaps(); // Re-scan to update results
  } else {
    showToast(`Could not swap — salary cap exceeded in all lineups`, 'warn', 3000);
  }
}

function runPortfolioSim() {
  if (!STATE.portfolioLineups.length || !STATE.POOL.length) return;
  const btn = document.getElementById('port-sim-btn');
  const out = document.getElementById('port-sim-results');
  if (!btn || !out) return;
  // Reuse the UI sims-per-lineup control so portfolio re-sim count matches user intent.
  const portfolioSimCount = parseInt(document.getElementById('port-sim-filter-sims')?.value) || 2000;
  btn.textContent = 'Simulating…'; btn.disabled = true;
  out.innerHTML = `<div class="ib blue" style="font-size:12px">Running ${portfolioSimCount.toLocaleString()} simulations per lineup against a synthetic ownership-weighted field…</div>`;

  setTimeout(async () => {
    try {
      const contestType = document.getElementById('port-contest-type')?.value || 'gpp';
      const manualCashLine = parseFloat(document.getElementById('port-cash-line')?.value) || null;
      const manualWinLine = parseFloat(document.getElementById('port-win-line')?.value) || null;
      const payoutType = document.getElementById('port-payout-type')?.value || 'top20';
      let simCustomPayoutConfig = null;
      if (payoutType === 'custom') {
        const cashPct = parseFloat(document.getElementById('custom-cash-pct')?.value || '20') / 100;
        const cashMult = parseFloat(document.getElementById('custom-cash-mult')?.value || '2.5');
        const winPct = parseFloat(document.getElementById('custom-win-pct')?.value || '0.5') / 100;
        const winMult = parseFloat(document.getElementById('custom-win-mult')?.value || '15');
        simCustomPayoutConfig = { cashPct, cashMult, winPct, winMult };
      }
      const pool = getCalibratedPool();
      const portContestSize = parseInt(document.getElementById('port-contest-size')?.value) || 1000;
      const simResults = await simulatePortfolioWorker(
        STATE.portfolioLineups,
        pool,
        portfolioSimCount,
        contestType,
        manualCashLine,
        manualWinLine,
        payoutType,
        portContestSize,
        simCustomPayoutConfig,
        { corrScale: 1.0, simDiversity: 1.0 }
      );

      if (!simResults.length) {
        out.innerHTML = '<div class="ib warn">Simulation failed — ensure players have projection data.</div>';
        return;
      }

      // Hand off to the state-driven table renderer. All sort/filter/expand/compare
      // logic lives there; this function's job is just to fetch and stage results.
      _simState.setResults(simResults, {
        isCash: contestType === 'cash',
        portfolioLineups: STATE.portfolioLineups,
      });
      renderSimTable();
    } catch (e) {
      console.error('Portfolio simulation failed:', e);
      out.innerHTML = `<div class="ib warn">Simulation error: ${e.message}</div>`;
    } finally {
      btn.textContent = 'Simulate Portfolio (P Threshold)'; btn.disabled = false;
    }
  }, 30);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Sim Table — state-driven drill-down view for portfolio sim results
//
// Features:
//  A. Expandable rows showing full roster + ownership/salary/median per player
//  B. Sortable columns (click headers to sort asc/desc)
//  C. Rich stack signature: "NYY 5 + ATL 2 (BB)" instead of just "NYY 4"
//  D. Stable 2-char fingerprint hash per lineup so users can identify lineups
//     across sim re-runs (and reorder operations)
//  E. Filter chips: stack team + ROI band
//  F. Color-coded top-3/bottom-3 ROI rows + ⭐ for top-3 P90 (ceiling)
//  G. Compare panel: check 2-4 rows → side-by-side diff modal
//  H. Ownership shown inline when row is expanded (no need to cross-reference)
//  I. Export filtered subset to DK CSV (top-N by current sort)
//  J. Per-lineup contest fit suggestion (Cash / Small GPP / Large GPP / Skip)
// ═══════════════════════════════════════════════════════════════════════════════

// Module-level state — persisted across renders so re-sorts/filters don't re-run the sim
const _simState = {
  results: [],            // simResults array, sorted by simROI_lb on intake
  isCash: false,
  cashLine: 0,
  portfolioLineups: [],   // reference to STATE.portfolioLineups at sim time
  origIdxByLu: new Map(), // lu → original portfolio index (1-based label = idx + 1)
  origSimRank: new Map(), // lu → 1-based rank when results first arrived (by simROI_lb)
  fingerprints: new Map(), // lu → 'K7' style hash
  sigCache: new Map(),    // lu → { primary, secondary, bringBack }
  fitCache: new Map(),    // lu → { tier, label, color }

  sortCol: 'simROI',
  sortDir: -1,
  filterStack: 'ALL',
  filterROI: 'ALL',       // 'ALL' | 'positive' | 'top10' | 'negative'
  expanded: new Set(),    // luIdx ids (original portfolio index)
  selected: new Set(),    // luIdx ids (original portfolio index)

  setResults(simResults, opts) {
    this.results = simResults;
    this.isCash = !!opts.isCash;
    this.cashLine = simResults[0]?.cashLine || 0;
    this.portfolioLineups = opts.portfolioLineups;
    this.origIdxByLu.clear();
    this.origSimRank.clear();
    this.fingerprints.clear();
    this.sigCache.clear();
    this.fitCache.clear();
    this.expanded.clear();
    this.selected.clear();

    // CRITICAL: results come back through a Web Worker which structurally clones the
    // lineup arrays — so r.lu is a NEW array, not reference-equal to portfolioLineups[i].
    // Match by content instead (sorted player names form a stable identity key).
    const contentKey = lu => lu.filter(Boolean).map(p => p.name).sort().join('|');
    const portfolioByKey = new Map();
    opts.portfolioLineups.forEach((lu, i) => portfolioByKey.set(contentKey(lu), i));

    // simResults arrives sorted by simROI_lb desc — store that as the "original" rank
    simResults.forEach((r, i) => {
      const idx = portfolioByKey.get(contentKey(r.lu));
      if (idx !== undefined) this.origIdxByLu.set(r.lu, idx);
      this.origSimRank.set(r.lu, i + 1);
      this.fingerprints.set(r.lu, _simFingerprint(r.lu));
      this.sigCache.set(r.lu, _simStackSig(r.lu));
      this.fitCache.set(r.lu, _simContestFit(r));
    });
  },

  origIdx(lu) { return this.origIdxByLu.get(lu); },
};

// Stable 2-char alphanumeric fingerprint for a lineup. Uses FNV-1a over sorted
// player names, then maps low 10 bits to two chars from a 32-char alphabet that
// skips 0/1/I/O to stay legible at 10px.
function _simFingerprint(lu) {
  const names = lu.filter(Boolean).map(p => p.name).sort().join('|');
  let h = 2166136261 >>> 0;
  for (let i = 0; i < names.length; i++) {
    h ^= names.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars
  return chars[h & 31] + chars[(h >>> 5) & 31];
}

// Stack signature: identifies a lineup's batter construction at a glance.
// Returns the primary team count, optional secondary mini-stack (2+), and
// flags whether the secondary is the opponent (bring-back game stack).
function _simStackSig(lu) {
  const teamCts = {};
  lu.forEach(p => { if (p && !rp(p, 'P')) teamCts[p.team] = (teamCts[p.team] || 0) + 1; });
  const sorted = Object.entries(teamCts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const primary = sorted[0] ? { team: sorted[0][0], count: sorted[0][1] } : null;
  const secondary = sorted[1] && sorted[1][1] >= 2 ? { team: sorted[1][0], count: sorted[1][1] } : null;
  let bringBack = false;
  if (primary && secondary) {
    const primaryPlayer = lu.find(p => p && p.team === primary.team);
    if (primaryPlayer && primaryPlayer.opp === secondary.team) bringBack = true;
  }
  return { primary, secondary, bringBack };
}

// Contest fit classifier. Uses score distribution shape + ownership profile.
//   Cash: high floor (P10), low variance, high cash rate
//   Large GPP: high ceiling (P90), low average ownership
//   Small GPP: solid median + acceptable ROI
//   Skip: neither — projection probably weak or construction wrong
function _simContestFit(r) {
  if (!r.p50 || r.p50 <= 0) return null;
  const players = r.lu.filter(Boolean);
  const avgOwn = players.length ? players.reduce((s, p) => s + (p.own || 0), 0) / players.length : 0;
  const spread = (r.p90 - r.p10) / r.p50;
  if (r.p10 >= 100 && spread < 0.65 && r.cashRate >= 45) {
    return { tier: 'Cash', label: 'Cash', color: 'var(--tsu)' };
  }
  if (r.p90 >= 195 && avgOwn < 15) {
    return { tier: 'Large GPP', label: 'Lg GPP', color: 'var(--ti)' };
  }
  if (r.p50 >= 130 && r.simROI > -12) {
    return { tier: 'Small GPP', label: 'Sm GPP', color: 'var(--tw)' };
  }
  return { tier: 'Skip', label: 'Skip', color: 'var(--tt)' };
}

// Apply current sort + filters and return the visible subset of sim results.
function _simVisibleResults() {
  let rows = _simState.results.slice();

  if (_simState.filterStack !== 'ALL') {
    rows = rows.filter(r => {
      const sig = _simState.sigCache.get(r.lu);
      return sig?.primary?.team === _simState.filterStack;
    });
  }

  if (_simState.filterROI !== 'ALL') {
    rows = rows.filter(r => {
      if (_simState.filterROI === 'positive') return r.simROI >= 0;
      if (_simState.filterROI === 'negative') return r.simROI < 0;
      if (_simState.filterROI === '+5plus') return r.simROI >= 5;
      return true;
    });
  }

  const col = _simState.sortCol;
  const dir = _simState.sortDir;
  rows.sort((a, b) => {
    let av, bv;
    switch (col) {
      case 'origIdx': av = _simState.origIdx(a.lu); bv = _simState.origIdx(b.lu); break;
      case 'fp':      av = _simState.fingerprints.get(a.lu); bv = _simState.fingerprints.get(b.lu); break;
      case 'stack':
        av = _simState.sigCache.get(a.lu)?.primary?.team || '';
        bv = _simState.sigCache.get(b.lu)?.primary?.team || '';
        break;
      case 'fit':
        av = _simState.fitCache.get(a.lu)?.tier || '';
        bv = _simState.fitCache.get(b.lu)?.tier || '';
        break;
      default: av = a[col] ?? 0; bv = b[col] ?? 0;
    }
    if (av < bv) return -1 * dir;
    if (av > bv) return  1 * dir;
    return 0;
  });

  // Top-3 ROI = top 3 in current visible set ordered by simROI desc (for highlighting).
  // P90 stars: top 3 by ceiling. Computed once over the visible set so they update with filters.
  const byROI = rows.slice().sort((a, b) => b.simROI - a.simROI);
  const top3ROI = new Set(byROI.slice(0, 3).map(r => r.lu));
  const bot3ROI = new Set(byROI.slice(-3).map(r => r.lu));
  const byP90 = rows.slice().sort((a, b) => b.p90 - a.p90);
  const top3P90 = new Set(byP90.slice(0, 3).map(r => r.lu));

  return { rows, top3ROI, bot3ROI, top3P90 };
}

// Color for the expected-dupes cell by risk band (low dupes = good/green = leverage).
function dupeColor(risk) {
  return risk === 'Unique' ? 'var(--tsu)' : risk === 'Low' ? 'var(--ti)' : risk === 'Med' ? 'var(--tw)' : 'var(--td)';
}

// Render the entire sim results panel. Called on intake AND after every sort/filter/expand.
function renderSimTable() {
  const out = document.getElementById('port-sim-results');
  if (!out) return;
  if (!_simState.results.length) { out.innerHTML = ''; return; }

  const isCash = _simState.isCash;
  const allResults = _simState.results;
  const avgROI    = allResults.reduce((s, r) => s + r.simROI,       0) / allResults.length;
  const avgCash   = allResults.reduce((s, r) => s + r.cashRate,     0) / allResults.length;
  const avgROISE  = allResults.reduce((s, r) => s + (r.simROI_se || 0), 0) / allResults.length;

  let html = `<div class="ib blue" style="font-size:12px;margin-bottom:8px">
    Sim results vs. ownership-weighted field. Cash line ≈ <strong>${_simState.cashLine}</strong> pts.
    Portfolio avg cash rate: <strong>${avgCash.toFixed(1)}%</strong> · Avg P(Thresh): <strong style="color:${avgROI >= 0 ? 'var(--tsu)' : 'var(--td)'}">${avgROI >= 0 ? '+' : ''}${avgROI.toFixed(1)}%</strong>${avgROISE > 0 ? ` <span style="color:var(--tt);font-weight:400">± ${avgROISE.toFixed(1)}%</span>` : ''}
  </div>`;

  // Paradox alert (GPP, high cash rate + negative ROI) — unchanged logic
  if (!isCash && avgCash > 27 && avgROI < -15) {
    const expSorted = Object.entries(STATE.portfolioExposure || {})
      .map(([name, e]) => ({ name, ...e, count: e.count ?? 0 }))
      .filter(e => e.count > 0);
    const topTeamStack = STATE.lastPortfolioResult?.teamStackCounts
      ? Object.entries(STATE.lastPortfolioResult.teamStackCounts)
          .map(([team, count]) => ({ team, count, pct: count / STATE.portfolioLineups.length * 100 }))
          .sort((a, b) => b.count - a.count)[0]
      : null;
    const topPitcher = expSorted.filter(e => e.isPitcher).sort((a, b) => b.count - a.count)[0];
    const teamMsg = topTeamStack && topTeamStack.pct > 50
      ? `Top stack: <strong>${esc(topTeamStack.team)}</strong> in ${topTeamStack.pct.toFixed(0)}% of lineups. Cap to 40-45% via Team Exposure override.`
      : '';
    const pitcherMsg = topPitcher && topPitcher.count / STATE.portfolioLineups.length > 0.60
      ? `Top pitcher: <strong>${esc(topPitcher.name)}</strong> in ${(topPitcher.count / STATE.portfolioLineups.length * 100).toFixed(0)}% of lineups. Pivot to a lower-owned arm in 40% of lineups.`
      : '';
    html += `<div class="ib warn" style="margin-bottom:8px;font-size:12px">
      <strong>⚠ Cash-rate / Sim-ROI paradox detected</strong> — high cash rate (${avgCash.toFixed(1)}%) with negative ROI (${avgROI.toFixed(1)}%).<br>
      <span style="font-size:11px">Your projection model is working, but construction is too field-correlated. Your lineups cash when chalk cashes, so finish position never reaches the top.</span>
      ${teamMsg ? `<br><span style="font-size:11px">→ ${teamMsg}</span>` : ''}
      ${pitcherMsg ? `<br><span style="font-size:11px">→ ${pitcherMsg}</span>` : ''}
      <br><span style="font-size:11px">→ Other fixes: raise 5-man stack %, tighten Max Overlap, increase ownershipLambda.</span>
    </div>`;
  }
  if (avgROISE > 2.0) {
    html += `<div class="ib blue" style="margin-bottom:6px;font-size:11px">⚠ Sim noise: average ROI uncertainty is ±${avgROISE.toFixed(1)}%. Consider running more sims for tighter intervals.</div>`;
  }

  // Build filter toolbar
  const stackTeams = [...new Set(allResults.map(r => _simState.sigCache.get(r.lu)?.primary?.team).filter(Boolean))].sort();
  const visible = _simVisibleResults();

  const filterChip = (label, key, val, active) =>
    `<button class="chip${active ? ' selected' : ''}" style="font-size:10px;padding:2px 8px" onclick="simSetFilter('${key}','${val}')">${esc(label)}</button>`;
  const stackOptions = ['ALL', ...stackTeams].map(t =>
    `<option value="${esc(t)}"${_simState.filterStack === t ? ' selected' : ''}>${esc(t === 'ALL' ? 'All stacks' : t)}</option>`
  ).join('');

  html += `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:6px 0 8px;padding:8px;background:var(--bs);border:0.5px solid var(--brd-s);border-radius:4px;font-size:11px">
    <span style="color:var(--tt);font-weight:600">FILTERS:</span>
    <label style="display:flex;align-items:center;gap:4px;color:var(--ts)">
      Stack:
      <select onchange="simSetFilter('stack', this.value)" style="font-size:11px;padding:2px 4px;background:var(--bp);color:var(--tp);border:0.5px solid var(--brd-s);border-radius:3px">${stackOptions}</select>
    </label>
    <div style="display:flex;gap:4px;align-items:center">
      <span style="color:var(--ts)">ROI:</span>
      ${filterChip('All',   'roi', 'ALL',      _simState.filterROI === 'ALL')}
      ${filterChip('+',     'roi', 'positive', _simState.filterROI === 'positive')}
      ${filterChip('+5%↑',  'roi', '+5plus',   _simState.filterROI === '+5plus')}
      ${filterChip('−',     'roi', 'negative', _simState.filterROI === 'negative')}
    </div>
    <span style="color:var(--tt);margin-left:auto">Showing ${visible.rows.length} / ${allResults.length}</span>
    ${_simState.selected.size >= 2 ? `<button class="btn-g" style="font-size:11px;padding:3px 10px" onclick="simShowCompare()">Compare (${_simState.selected.size})</button>` : ''}
    ${_simState.selected.size > 0 ? `<button class="btn" style="font-size:11px;padding:3px 10px" onclick="simClearSelection()">Clear sel.</button>` : ''}
    <button class="btn-p" style="font-size:11px;padding:3px 10px" onclick="simExportFiltered()" title="Export the currently filtered/sorted lineups to a DK-format CSV.">Export ${visible.rows.length} to DK CSV</button>
  </div>`;

  // Table
  const sortArrow = col => _simState.sortCol === col ? (_simState.sortDir === -1 ? ' ▼' : ' ▲') : '';
  const sh = (col, label, title) =>
    `<th style="cursor:pointer;user-select:none" title="${esc(title || 'Click to sort')}" onclick="simSort('${col}')">${esc(label)}${sortArrow(col)}</th>`;

  html += `<div style="overflow-x:auto"><table style="width:100%;font-size:11px">
    <thead><tr>
      <th style="width:24px"></th>
      ${sh('origIdx', '#', 'Original portfolio number')}
      ${sh('fp', 'ID', 'Stable lineup fingerprint — same lineup gets same ID across sim runs')}
      ${sh('p50', 'P50', 'Median simulated score')}
      ${sh('p10', 'P10', 'Floor — 10th percentile')}
      ${sh('p90', 'P90', 'Ceiling — 90th percentile')}
      ${sh('cashRate', 'Cash%', 'Sim cash rate vs. field')}
      ${isCash ? '' : sh('winRate', 'Win%', 'Sim top-1% rate')}
      ${isCash ? '' : sh('expectedDupes', 'Dupes', 'Expected identical entries in the field — lower = more unique (leverage). Driven by your projected ownership and the contest size.')}
      ${sh('simROI', 'P(Thresh)', 'Probability of exceeding cash/win threshold (not true GPP ROI — see controls to enable field simulation)')}
      ${sh('fit', 'Fit', 'Best contest type based on score distribution + ownership')}
      ${sh('stack', 'Stack', 'Primary + secondary stack signature')}
    </tr></thead>
    <tbody>`;

  visible.rows.forEach(r => {
    const origIdx = _simState.origIdx(r.lu);
    // Fallback: if content-key match failed (worker dropped an entry, custom build
    // workflow, etc.) use the sim rank as a stable identity so labels and the
    // expand/select Sets still work — never produce `#NaN` or collide with key `undefined`.
    const luKey = origIdx ?? (_simState.origSimRank.get(r.lu) - 1 + 10000); // offset to avoid collision with real origIdx
    const labelNum = origIdx != null ? (origIdx + 1) : `S${_simState.origSimRank.get(r.lu)}`;
    const fp = _simState.fingerprints.get(r.lu);
    const sig = _simState.sigCache.get(r.lu);
    const fit = _simState.fitCache.get(r.lu);
    const roi = r.simROI;
    const roiColor = roi >= 10 ? 'var(--tsu)' : roi >= 0 ? 'var(--ti)' : 'var(--td)';
    const seStr = r.simROI_se > 0 ? ` <span style="color:var(--tt);font-weight:400;font-size:10px">±${r.simROI_se.toFixed(1)}</span>` : '';

    // Stack signature pill
    const primaryPill = sig.primary
      ? `<span class="pill ${sig.primary.count >= 5 ? 'psu' : sig.primary.count >= 4 ? 'pi' : 'pw'}" style="font-size:9px">${esc(sig.primary.team)} ${sig.primary.count}</span>`
      : '—';
    const secondaryPill = sig.secondary
      ? ` <span class="pill ${sig.bringBack ? 'pi' : 'pw'}" style="font-size:9px">${sig.bringBack ? '↩ ' : '+ '}${esc(sig.secondary.team)} ${sig.secondary.count}</span>`
      : '';

    // F: row highlighting based on visible-set ranking
    const isTop3 = visible.top3ROI.has(r.lu);
    const isBot3 = visible.bot3ROI.has(r.lu);
    const isTopP90 = visible.top3P90.has(r.lu);
    const rowBg = isTop3 ? 'background:rgba(34,197,94,.07)' : isBot3 ? 'background:rgba(239,68,68,.07)' : '';

    const isExpanded = _simState.expanded.has(luKey);
    const isSelected = _simState.selected.has(luKey);
    const expandIcon = isExpanded ? '▾' : '▸';

    html += `<tr style="${rowBg};cursor:pointer" onclick="simToggleExpand(${luKey})">
      <td onclick="event.stopPropagation();simToggleSelect(${luKey})" style="text-align:center;cursor:pointer" title="Select for compare">
        <input type="checkbox" ${isSelected ? 'checked' : ''} style="cursor:pointer;width:13px;height:13px" onclick="event.stopPropagation();simToggleSelect(${luKey})">
      </td>
      <td><span style="color:var(--ts)">${expandIcon}</span> <strong>#${labelNum}</strong>${isTopP90 ? ' <span title="Top-3 ceiling">⭐</span>' : ''}</td>
      <td><span class="pill" style="font-size:10px;font-family:monospace;background:var(--bs);border:0.5px solid var(--brd-s);color:var(--ts)">${fp}</span></td>
      <td>${r.p50.toFixed(1)}</td>
      <td style="color:var(--ts)">${r.p10.toFixed(1)}</td>
      <td style="color:var(--tsu)">${r.p90.toFixed(1)}</td>
      <td>${r.cashRate}%</td>
      ${isCash ? '' : `<td>${r.winRate}%</td>`}
      ${isCash ? '' : `<td title="${r.dupeRisk} dupe risk · ${r.pUnique != null ? r.pUnique + '% chance this lineup is unique' : ''}"><span style="color:${dupeColor(r.dupeRisk)};font-weight:600">${r.expectedDupes != null ? r.expectedDupes.toFixed(1) : '—'}</span> <span style="font-size:9px;color:var(--tt)">${esc(r.dupeRisk || '')}</span></td>`}
      <td style="font-weight:600;color:${roiColor}">${roi >= 0 ? '+' : ''}${roi}%${seStr}</td>
      <td>${fit ? `<span style="color:${fit.color};font-weight:600;font-size:10px">${esc(fit.label)}</span>` : '—'}</td>
      <td>${primaryPill}${secondaryPill}</td>
    </tr>`;

    if (isExpanded) {
      html += `<tr style="${rowBg}"><td colspan="${isCash ? 10 : 12}" style="padding:8px 12px;background:rgba(0,0,0,.15)">
        ${_simExpandedRoster(r)}
      </td></tr>`;
    }
  });

  if (!visible.rows.length) {
    html += `<tr><td colspan="${isCash ? 10 : 12}" style="text-align:center;color:var(--tt);padding:14px">No lineups match the current filters.</td></tr>`;
  }

  html += '</tbody></table></div>';
  out.innerHTML = html;
}

// Expanded-row content: full roster with position, ownership, salary, projection.
// Ownership shown inline so the user doesn't have to cross-reference the exposure table
// to understand why a lineup is chalk-heavy or contrarian.
function _simExpandedRoster(r) {
  const players = r.lu.filter(Boolean);
  const totalSal = players.reduce((s, p) => s + (p.salary || 0), 0);
  const totalMed = players.reduce((s, p) => s + (p.median || 0), 0);
  const avgOwn = players.length ? players.reduce((s, p) => s + (p.own || 0), 0) / players.length : 0;
  const slots = activeSlots();
  // Portfolio-level exposure for context (H — ownership overlay shows both projected own
  // and what % of YOUR portfolio this player is in, so you can spot leverage drains).
  const exp = STATE.portfolioExposure || {};

  const chips = r.lu.map((p, i) => {
    if (!p) return '';
    const slot = slots[i]?.key || '';
    const ownStr = p.own > 0 ? `${p.own.toFixed(0)}%` : '—';
    const ownColor = p.own > 30 ? 'var(--td)' : p.own > 18 ? 'var(--tw)' : p.own > 8 ? 'var(--ti)' : 'var(--tsu)';
    const portExp = exp[p.name];
    const portStr = portExp ? ` <span style="color:${parseFloat(portExp.pct) > 60 ? 'var(--td)' : 'var(--tt)'};font-size:9px">port ${portExp.pct}%</span>` : '';
    return `<div style="display:inline-flex;flex-direction:column;align-items:flex-start;background:var(--bp);border:0.5px solid var(--brd-s);border-radius:4px;padding:4px 8px;margin:2px;min-width:160px">
      <div style="font-size:9px;color:var(--tt);text-transform:uppercase;letter-spacing:.04em">${esc(slot)}</div>
      <div style="font-size:12px;font-weight:600;color:var(--tp)">${esc(p.name)}</div>
      <div style="font-size:10px;color:var(--ts);display:flex;gap:6px;flex-wrap:wrap">
        <span>${esc(p.team || '')}${p.order > 0 ? ' #' + p.order : ''}</span>
        <span>$${(p.salary || 0).toLocaleString()}</span>
        <span>${(p.median || 0).toFixed(1)} med</span>
        <span style="color:${ownColor}">own ${ownStr}</span>
        ${portStr}
      </div>
    </div>`;
  }).join('');

  return `<div style="display:flex;flex-wrap:wrap;gap:0;align-items:stretch">${chips}</div>
    <div style="margin-top:6px;font-size:11px;color:var(--ts);display:flex;gap:14px;flex-wrap:wrap">
      <span>Salary: <strong>$${totalSal.toLocaleString()}</strong></span>
      <span>Proj. Median: <strong>${totalMed.toFixed(1)}</strong></span>
      <span>Avg Own: <strong style="color:${avgOwn > 18 ? 'var(--td)' : avgOwn > 12 ? 'var(--tw)' : 'var(--tsu)'}">${avgOwn.toFixed(1)}%</strong></span>
      ${r.expectedDupes != null ? `<span title="Expected identical entries in the field — lower is more unique">Est. dupes: <strong style="color:${dupeColor(r.dupeRisk)}">${r.expectedDupes.toFixed(1)}</strong> <span style="color:var(--tt)">(${r.dupeRisk}, ${r.pUnique}% unique)</span></span>` : ''}
      <span style="color:var(--tt)">Original sim rank: <strong>${_simState.origSimRank.get(r.lu) || '?'}</strong></span>
    </div>`;
}

// ── Sim table action handlers (called from inline onclick) ─────────────────────

window.simSort = function(col) {
  if (_simState.sortCol === col) _simState.sortDir = -_simState.sortDir;
  else { _simState.sortCol = col; _simState.sortDir = -1; }
  renderSimTable();
};

window.simSetFilter = function(key, val) {
  if (key === 'stack') _simState.filterStack = val;
  else if (key === 'roi') _simState.filterROI = val;
  renderSimTable();
};

window.simToggleExpand = function(luIdx) {
  if (_simState.expanded.has(luIdx)) _simState.expanded.delete(luIdx);
  else _simState.expanded.add(luIdx);
  renderSimTable();
};

window.simToggleSelect = function(luIdx) {
  if (_simState.selected.has(luIdx)) _simState.selected.delete(luIdx);
  else if (_simState.selected.size < 4) _simState.selected.add(luIdx);
  else showToast('Compare limited to 4 lineups at a time. Deselect one to add another.', 'warn', 3000);
  renderSimTable();
};

window.simClearSelection = function() {
  _simState.selected.clear();
  renderSimTable();
};

// G: side-by-side compare modal showing shared/unique players + delta stats
window.simShowCompare = function() {
  if (_simState.selected.size < 2) return;
  // Resolve selected luIdx → sim results. Lookup is by origIdx (not reference equality)
  // because the worker round-trip clones the lineup arrays.
  const picked = [..._simState.selected].sort((a, b) => a - b).map(idx => {
    return _simState.results.find(r => _simState.origIdx(r.lu) === idx);
  }).filter(Boolean);

  // Compute intersection of player names across all picked lineups
  const allNames = picked.map(r => new Set(r.lu.filter(Boolean).map(p => p.name)));
  const shared = [...allNames[0]].filter(name => allNames.every(s => s.has(name)));
  const uniquePerLineup = picked.map((r, i) =>
    r.lu.filter(p => p && !allNames.every(s => s.has(p.name))).map(p => p.name)
  );

  const colHtml = picked.map((r, i) => {
    const origIdx = _simState.origIdx(r.lu);
    const fp = _simState.fingerprints.get(r.lu);
    const fit = _simState.fitCache.get(r.lu);
    const sig = _simState.sigCache.get(r.lu);
    const sigStr = sig.primary
      ? `${sig.primary.team} ${sig.primary.count}${sig.secondary ? (sig.bringBack ? ' ↩ ' : ' + ') + sig.secondary.team + ' ' + sig.secondary.count : ''}`
      : '—';
    const sal = r.lu.reduce((s, p) => s + (p?.salary || 0), 0);
    const avgOwn = r.lu.filter(Boolean).reduce((s, p) => s + (p.own || 0), 0) / r.lu.filter(Boolean).length;
    return `<div style="flex:1;min-width:200px;padding:8px;background:var(--bs);border:0.5px solid var(--brd-s);border-radius:4px">
      <div style="font-size:12px;font-weight:600;margin-bottom:6px">#${origIdx + 1} <span style="font-family:monospace;color:var(--ts);font-size:10px">${fp}</span></div>
      <div style="font-size:10px;color:var(--ts);line-height:1.6">
        Stack: <strong>${esc(sigStr)}</strong><br>
        Fit: <strong style="color:${fit?.color || 'var(--tt)'}">${esc(fit?.label || '—')}</strong><br>
        Salary: <strong>$${sal.toLocaleString()}</strong><br>
        P50 / P90: <strong>${r.p50.toFixed(1)}</strong> / <strong style="color:var(--tsu)">${r.p90.toFixed(1)}</strong><br>
        Cash: <strong>${r.cashRate}%</strong> · ROI: <strong style="color:${r.simROI >= 0 ? 'var(--tsu)' : 'var(--td)'}">${r.simROI >= 0 ? '+' : ''}${r.simROI}%</strong><br>
        Avg own: <strong>${avgOwn.toFixed(1)}%</strong>
      </div>
      <div style="margin-top:8px;font-size:10px;color:var(--tt);text-transform:uppercase">Unique players</div>
      <div style="display:flex;flex-wrap:wrap;gap:3px;margin-top:4px">
        ${uniquePerLineup[i].map(n => `<span class="chip" style="font-size:10px">${esc(n)}</span>`).join('') || '<span style="color:var(--tt);font-size:10px">(all shared)</span>'}
      </div>
    </div>`;
  }).join('');

  const sharedChips = shared.length
    ? shared.map(n => `<span class="chip" style="font-size:10px">${esc(n)}</span>`).join('')
    : '<span style="color:var(--tt);font-size:11px">(none — totally distinct constructions)</span>';

  const modal = document.createElement('div');
  modal.id = 'sim-compare-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
  modal.innerHTML = `<div style="background:var(--bp);border:1px solid var(--brd-s);border-radius:6px;padding:18px;max-width:1100px;width:100%;max-height:88vh;overflow-y:auto">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <div style="font-size:14px;font-weight:600">Compare ${picked.length} Lineups</div>
      <button class="btn" style="font-size:11px;padding:3px 10px" onclick="simHideCompare()">Close ✕</button>
    </div>
    <div style="margin-bottom:10px;font-size:11px;color:var(--ts)">
      <strong>Shared players (${shared.length}):</strong>
      <div style="display:flex;flex-wrap:wrap;gap:3px;margin-top:4px">${sharedChips}</div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">${colHtml}</div>
  </div>`;
  modal.addEventListener('click', e => { if (e.target === modal) window.simHideCompare(); });
  document.body.appendChild(modal);
};

window.simHideCompare = function() {
  const m = document.getElementById('sim-compare-modal');
  if (m) m.remove();
};

// I: Export the currently filtered+sorted lineup subset to DK-format CSV.
// Same validation as exportPortfolio but works on the visible rows so the user
// can ship only their best N (e.g. top 10 by ROI after sort).
window.simExportFiltered = function() {
  const visible = _simVisibleResults();
  if (!visible.rows.length) { showToast('No lineups match the current filters.', 'warn', 3000); return; }

  const lineups = visible.rows.map(r => r.lu);
  const invalidLineups = [];
  const overCap = [];
  const cap = activeSalaryCap();
  lineups.forEach((lu, idx) => {
    if (!lu.every(Boolean)) invalidLineups.push(idx + 1);
    const sal = lu.reduce((s, p) => s + (p?.salary || 0), 0);
    if (sal > cap) overCap.push(`#${idx + 1} ($${sal.toLocaleString()})`);
  });
  if (invalidLineups.length) { alert(`${invalidLineups.length} lineup(s) have empty slots. Regenerate the portfolio.`); return; }
  if (overCap.length) { alert(`${overCap.length} lineup(s) exceed $${cap.toLocaleString()} cap: ${overCap.slice(0, 5).join(', ')}.`); return; }

  const missing = lineups.flat().filter(p => p && !p.dkId);
  if (missing.length) {
    const unique = [...new Set(missing.map(p => p.name))];
    alert('Missing DK IDs for: ' + unique.slice(0, 5).join(', ') + '\nUpload your DK Salaries CSV first.');
    return;
  }

  const slots = activeSlots();
  const header = slots.map(s => s.label).join(',');
  const rows = lineups.map(lu => lu.map(p => p.dkId).join(','));
  dlFile(header + '\n' + rows.join('\n'), `portfolio_filtered_${lineups.length}lus.csv`, 'text/csv');
  showToast(`Exported ${lineups.length} lineups to DK CSV.`, 'success', 3000);
};

async function savePortfolioToHistory() {
  if (!STATE.portfolioLineups.length) return;
  const contest = document.getElementById('port-contest-type')?.value?.toUpperCase() || 'GPP';
  const slateDate = new Date().toISOString().substring(0, 10);
  const buyin = 0; // can be updated later in backtest tab

  const btn = document.querySelector('[onclick="savePortfolioToHistory()"]');
  if (btn) { btn.textContent = 'Saving...'; btn.disabled = true; }

  // Capture pool snapshot and active calibration once — shared across all lineups.
  // Previously omitted, causing poolSnapshot: [] for every portfolio entry and breaking
  // the projection accuracy calibration (which needs full slate data, not just 10 players).
  const activeCal = Engine.getCalibration();
  const poolSnapshot = STATE.POOL.map(p => ({
    name: p.name, team: p.team, pos: p.dkPos, salary: p.salary,
    median: p.median || 0, floor: p.floor || 0, ceiling: p.ceiling || 0,
    own: p.own || 0, order: p.order || 0
  }));

  let saved = 0, failed = 0;
  for (const lu of STATE.portfolioLineups) {
    const players = lu.filter(Boolean);
    if (!players.length) continue;
    const lineupSnapshot = players.map(p => ({
      name: p.name, team: p.team, pos: p.dkPos, salary: p.salary,
      median: p.median || 0, floor: p.floor || 0, ceiling: p.ceiling || 0,
      own: p.own || 0, order: p.order || 0, hand: p.hand || ''
    }));
    try {
      await fetch('/api/history', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contest, buyin, slateDate,
          projectedPts: players.reduce((s, p) => s + (p.median || 0), 0),
          projectedOwn: players.reduce((s, p) => s + (p.own || 0), 0),
          salary: players.reduce((s, p) => s + p.salary, 0),
          lineup: lineupSnapshot,
          poolSnapshot,
          calibBatterScale: activeCal.batterScale || 1.0,
          calibPitcherScale: activeCal.pitcherScale || 1.0
        })
      });
      saved++;
    } catch (e) { failed++; }
  }

  if (btn) {
    btn.textContent = failed ? `Saved ${saved}, ${failed} failed` : `Saved ${saved} lineups!`;
    btn.className = failed ? 'btn' : 'btn-g';
    setTimeout(() => { btn.textContent = 'Save All to Backtest History'; btn.className = 'btn-g'; btn.disabled = false; }, 2500);
  }
}

function exportPortfolio() {
  if (!STATE.portfolioLineups.length) return;

  // Validate every lineup: fully filled, under cap, has DK IDs
  const invalidLineups = [];
  const overCap = [];
  const activeCap = activeSalaryCap();
  STATE.portfolioLineups.forEach((lu, idx) => {
    if (!lu.every(Boolean)) invalidLineups.push(idx + 1);
    const sal = lu.reduce((s, p) => s + (p?.salary || 0), 0);
    if (sal > activeCap) overCap.push(`#${idx + 1} ($${sal.toLocaleString()})`);
  });
  if (invalidLineups.length) {
    alert(`${invalidLineups.length} lineup(s) have empty slots (lineup ${invalidLineups.slice(0,5).join(', ')}). Regenerate the portfolio.`);
    return;
  }
  const cap = activeSalaryCap();
  if (overCap.length) {
    alert(`${overCap.length} lineup(s) exceed the $${cap.toLocaleString()} cap: ${overCap.slice(0,5).join(', ')}.`);
    return;
  }
  const allPlayers = STATE.portfolioLineups.flat().filter(Boolean);
  const missing = allPlayers.filter(p => !p.dkId);
  if (missing.length) {
    const unique = [...new Set(missing.map(p => p.name))];
    alert('Missing DK IDs for: ' + unique.slice(0, 5).join(', ') + (unique.length > 5 ? '...' : '') + '\nUpload your DK Salaries CSV first.');
    return;
  }
  // Warn on injured, unconfirmed, or postponed players across the portfolio
  const poolMap = new Map(STATE.POOL.map(p => [p.name, p]));
  const warnNames = new Map();
  allPlayers.forEach(p => {
    if (!p || warnNames.has(p.name)) return;
    const pp = poolMap.get(p.name) || p;
    const warns = [];
    if (pp.dkStatus === 'O') warns.push('OUT (DK)');
    else if (pp.injuryType === 'IL') warns.push('On IL');
    else if (pp.injuryFlag) warns.push(pp.injuryDesc || pp.injuryType || 'Injured');
    if (!rp(pp, 'P') && pp.isConfirmed === false) warns.push('Unconfirmed');
    if (pp.isPostponed) warns.push('Game postponed');
    if (warns.length) warnNames.set(p.name, warns);
  });
  if (warnNames.size) {
    const msgs = [...warnNames.entries()].slice(0, 10).map(([name, warns]) => `• ${name}: ${warns.join(', ')}`);
    if (warnNames.size > 10) msgs.push(`  (+ ${warnNames.size - 10} more)`);
    if (!confirm(`Portfolio export warning:\n\n${msgs.join('\n')}\n\nExport ${STATE.portfolioLineups.length} lineups anyway?`)) return;
  }
  const slots = activeSlots();
  const header = slots.map(s => s.label).join(',');
  const rows = STATE.portfolioLineups.map(lu => lu.map(p => p.dkId).join(','));
  dlFile(header + '\n' + rows.join('\n'), 'portfolio_lineups.csv', 'text/csv');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIMULATOR TAB (Monte Carlo)
// ═══════════════════════════════════════════════════════════════════════════════
function runSimulation() {
  const playersInLineup = STATE.lineup.filter(Boolean);
  if (playersInLineup.length < 5) {
    document.getElementById('sim-results').innerHTML = '<div class="ib warn">Add at least 5 players to your lineup to simulate.</div>';
    return;
  }
  const numSims = parseInt(document.getElementById('sim-count')?.value) || 10000;
  // Always sync runtime engine knobs from UI before sim so limits/values are honored
  // even after restore or programmatic updates that may not fire input events.
  const corrScale = parseFloat(document.getElementById('sim-corr-scale')?.value);
  const simDiversity = parseFloat(document.getElementById('sim-diversity')?.value);
  if (!Number.isNaN(corrScale)) Engine.setCorrScale(corrScale);
  if (!Number.isNaN(simDiversity)) Engine.setSimDiversity(simDiversity);
  const btn = document.getElementById('run-sim-btn');
  btn.textContent = 'Simulating...'; btn.disabled = true;
  const ecEl = document.getElementById('edge-card');
  if (ecEl) ecEl.style.display = 'none';

  // Show how many historical pair correlations are active
  const pairStatus = document.getElementById('sim-pair-corr-status');
  if (pairStatus) {
    const pairCount = Object.keys(Engine.getPairCorrelation ? {} : {}).length;
    // Count via a known-pair check — actual count lives inside engine closure
    const histEntries = STATE.historyData.filter(h => h.playerActuals && Object.keys(h.playerActuals).length >= 2).length;
    pairStatus.textContent = histEntries >= 3
      ? `Using historical correlations from ${histEntries} slates`
      : 'Using structural correlations (save actuals in Backtest to add historical data)';
  }

  setTimeout(() => {
    try {
      const result = Engine.simulateLineup(STATE.lineup, numSims);
      const parseLine = id => { const v = parseFloat(document.getElementById(id)?.value); return isNaN(v) ? null : v; };
      const rates = Engine.computeLineupRates(
        result.rawTotals,
        parseLine('sim-cash-line'),
        parseLine('sim-top10-line'),
        parseLine('sim-win-line')
      );
      renderSimResults(result, rates);
      // Know Your Edge: edge profile vs chalk field baseline
      const edgeProfile = Engine.computeEdgeProfile(STATE.lineup, result.rawTotals, STATE.POOL, {
        payoutType: document.getElementById('edge-payout-type')?.value || 'top20',
        fieldSize:  parseFloat(document.getElementById('edge-field-size')?.value)  || 10000,
        entryFee:   parseFloat(document.getElementById('edge-entry-fee')?.value)   || 20,
        cashLine:   parseLine('sim-cash-line'),
        top10Line:  parseLine('sim-top10-line'),
        winLine:    parseLine('sim-win-line'),
      });
      renderEdgeCard(edgeProfile);
    } catch (err) {
      document.getElementById('sim-results').innerHTML = `<div class="ib warn">Simulation error: ${err.message}</div>`;
    } finally {
      btn.textContent = 'Run Simulation'; btn.disabled = false;
    }
  }, 50);
}

function renderSimResults(result, rates) {
  if (!result) return;
  const el = document.getElementById('sim-results');

  // Verdict card (Cash %, Top 10 %, Win % + plain-English analysis)
  let verdictHtml = '';
  if (rates) {
    const { cashPct, top10Pct, winPct } = rates;
    const verdict = computeSimVerdict(cashPct, top10Pct, winPct, result.correlationScore);
    const chipColor = (pct, gt, yt) =>
      pct == null ? 'var(--ts)' : pct >= gt ? '#22c55e' : pct >= yt ? '#f59e0b' : '#ef4444';
    const chip = (pct, label, gt, yt) => pct == null ? '' :
      `<div style="text-align:center;min-width:72px">
        <div style="font-size:26px;font-weight:700;color:${chipColor(pct,gt,yt)};line-height:1.1">${(pct*100).toFixed(1)}%</div>
        <div style="font-size:11px;color:var(--ts);margin-top:2px">${label}</div>
       </div>`;
    verdictHtml = `<div style="background:var(--bs);border:1px solid var(--brd);border-radius:var(--r);padding:14px 16px;margin-bottom:12px">
      <div style="display:flex;gap:20px;justify-content:center;margin-bottom:10px;flex-wrap:wrap">
        ${chip(cashPct,  'Cash %',   0.50, 0.40)}
        ${chip(top10Pct, 'Top 10 %', 0.20, 0.12)}
        ${chip(winPct,   'Win %',    0.10, 0.05)}
      </div>
      ${verdict ? `<div style="font-size:13px;font-weight:700;color:${verdict.color};margin-bottom:4px">${verdict.label}</div>
      <div style="font-size:12px;color:var(--ts);line-height:1.5">${verdict.text}</div>` : ''}
    </div>`;
  }

  // Summary stats
  // meanSE / p50SE are bootstrap standard errors — they quantify how much the
  // estimate would shift if you re-ran the simulation (pure sampling noise).
  // Thresholds are relative (SE / mean) so they scale with lineup magnitude:
  //   < 0.5% — stable
  //   0.5–2% — moderate (no banner)
  //   > 2%   — noisy, suggest more sims
  // Suggests roughly how many sims would halve the SE (SE scales 1/sqrt(N)).
  const meanCIStr = result.meanCI ? ` <span style="font-size:10px;color:var(--ts)" title="95% CI from 20-group bootstrap — run more sims to narrow this">[${result.meanCI[0]}–${result.meanCI[1]}]</span>` : '';
  const p50CIStr  = result.p50CI  ? ` <span style="font-size:10px;color:var(--ts)" title="95% CI from 20-group bootstrap">[${result.p50CI[0]}–${result.p50CI[1]}]</span>` : '';
  const relSE = result.mean > 0 ? result.meanSE / result.mean : 0;
  let stabilityNote = '';
  if (relSE > 0.02) {
    // Sim count to halve SE: SE ~ 1/sqrt(N), so to halve we need 4× sims.
    const suggested = Math.min(50000, Math.max(5000, (result.numSims || 10000) * 4));
    stabilityNote = `<div class="ib warn" style="margin-bottom:8px;font-size:12px">Simulation noise is moderate-to-high: SE=${result.meanSE.toFixed(2)} on mean ${result.mean.toFixed(1)} (${(relSE * 100).toFixed(1)}% relative). To halve the SE, increase sim count to ~${suggested.toLocaleString()}.</div>`;
  } else if (relSE < 0.005 && result.meanSE > 0) {
    stabilityNote = `<div class="ib" style="margin-bottom:8px;font-size:12px;color:var(--tsu)">Estimates are stable (SE=${result.meanSE.toFixed(2)}, ${(relSE * 100).toFixed(2)}% of mean).</div>`;
  }
  let html = verdictHtml + stabilityNote + `<div class="mc-row">
    <div class="mc"><div class="mc-l">Mean</div><div class="mc-v">${result.mean.toFixed(1)}${meanCIStr}</div></div>
    <div class="mc"><div class="mc-l">Std Dev</div><div class="mc-v">${result.std.toFixed(1)}</div></div>
    <div class="mc"><div class="mc-l">P10</div><div class="mc-v">${result.p10.toFixed(1)}</div></div>
    <div class="mc"><div class="mc-l">P50</div><div class="mc-v">${result.p50.toFixed(1)}${p50CIStr}</div></div>
    <div class="mc"><div class="mc-l">P90</div><div class="mc-v">${result.p90.toFixed(1)}</div></div>
    <div class="mc"><div class="mc-l">P99</div><div class="mc-v">${result.p99.toFixed(1)}</div></div>
    <div class="mc"><div class="mc-l">Max</div><div class="mc-v">${result.max.toFixed(1)}</div></div>
    <div class="mc"><div class="mc-l">Corr Score</div><div class="mc-v">${result.correlationScore.toFixed(3)}</div></div>
  </div>`;

  // Histogram
  const maxCount = Math.max(...result.histogram.map(b => b.count));
  html += `<div class="sec-label" style="margin-top:12px">Score Distribution (${result.numSims.toLocaleString()} sims)</div>
  <div style="display:flex;align-items:flex-end;gap:1px;height:120px;padding:8px 0;background:var(--bs);border-radius:var(--r);margin-bottom:12px">
    ${result.histogram.map(bin => {
      const h = Math.max(1, Math.round(bin.count / maxCount * 100));
      const isP50 = bin.lo <= result.p50 && bin.hi > result.p50;
      return `<div title="${bin.lo.toFixed(0)}-${bin.hi.toFixed(0)}: ${bin.count}" style="flex:1;height:${h}%;background:${isP50 ? 'var(--ti)' : 'var(--brd-i)'};border-radius:2px 2px 0 0;min-width:4px"></div>`;
    }).join('')}
  </div>
  <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--tt);margin-top:-8px;margin-bottom:12px">
    <span>${result.min.toFixed(0)}</span><span>P50: ${result.p50.toFixed(0)}</span><span>${result.max.toFixed(0)}</span>
  </div>`;

  // Player-level stats
  html += `<div class="sec-label">Player Outcomes</div>
  <div style="overflow-x:auto"><table><thead><tr><th>Player</th><th>Mean</th><th>P10</th><th>P50</th><th>P90</th><th>Std</th><th>Bust%</th><th>Boom%</th></tr></thead><tbody>
  ${result.playerStats.map(ps => {
    const bustColor = ps.bustRate > 0.3 ? 'var(--td)' : ps.bustRate > 0.15 ? 'var(--tw)' : 'var(--tsu)';
    const boomColor = ps.boomRate > 0.2 ? 'var(--tsu)' : ps.boomRate > 0.1 ? 'var(--ti)' : 'var(--ts)';
    return `<tr><td><strong>${esc(ps.name)}</strong></td><td>${ps.mean.toFixed(1)}</td><td>${ps.p10.toFixed(1)}</td><td>${ps.p50.toFixed(1)}</td><td>${ps.p90.toFixed(1)}</td><td>${ps.std.toFixed(1)}</td><td style="color:${bustColor}">${(ps.bustRate * 100).toFixed(1)}%</td><td style="color:${boomColor}">${(ps.boomRate * 100).toFixed(1)}%</td></tr>`;
  }).join('')}
  </tbody></table></div>`;

  el.innerHTML = html;
}

function computeSimVerdict(cashPct, top10Pct, winPct, corrScore) {
  const c = cashPct  != null ? cashPct  * 100 : null;
  const t = top10Pct != null ? top10Pct * 100 : null;
  const w = winPct   != null ? winPct   * 100 : null;
  if (c == null && w == null) return null;

  let label, color, text;
  if (w != null && w >= 15) {
    label = 'High Upside GPP Play';
    color = '#3b82f6';
    text = `Win probability is ${w.toFixed(1)}% — this stack booms when it connects. Big ceiling, but${c != null ? ` a ${c.toFixed(1)}% cash rate means` : ''} you need your correlation to fire.`;
  } else if (c != null && c >= 55) {
    label = 'Cash Game Lock';
    color = '#22c55e';
    text = `Cashes ${c.toFixed(1)}% of the time — well above break-even for double-ups and 50/50s. Consider adding more stack upside for large-field GPPs.`;
  } else if (c != null && c >= 48 && (t == null || t >= 20) && w != null && w >= 8) {
    label = 'Well-Rounded Build';
    color = '#22c55e';
    text = `Strong floor (${c.toFixed(1)}% cash rate) with real upside (${w.toFixed(1)}% win rate${t != null ? `, ${t.toFixed(1)}% top-10` : ''}). Suitable for most contest types.`;
  } else if (c != null && c >= 48 && (w == null || w < 8)) {
    label = 'Cash Game Build';
    color = '#84cc16';
    text = `Reliable ${c.toFixed(1)}% cash rate with modest GPP ceiling (${w != null ? w.toFixed(1) + '% win rate' : 'limited win potential'}). Great for cash; needs more stack correlation for large-field tournaments.`;
  } else if ((c == null || c < 38) && (w == null || w < 5)) {
    label = 'Risky Build';
    color = '#ef4444';
    text = `Low floor${c != null ? ` (${c.toFixed(1)}% cash rate)` : ''} and limited ceiling${w != null ? ` (${w.toFixed(1)}% win rate)` : ''}. Reconsider your stack structure or projections. Corr score: ${corrScore != null ? corrScore.toFixed(3) : 'n/a'}.`;
  } else {
    label = 'Tournament Contender';
    color = '#f59e0b';
    text = `${c != null ? `${c.toFixed(1)}% cash rate with ` : ''}${w != null ? `${w.toFixed(1)}% win potential` : 'moderate upside'}. Competes in mid-to-large GPPs. Corr score ${corrScore != null ? corrScore.toFixed(3) : 'n/a'} — higher correlation stacks your best outcomes together.`;
  }
  return { label, color, text };
}

async function loadSimBenchmarks() {
  const statusEl = document.getElementById('sim-bench-status');
  if (statusEl) statusEl.textContent = 'Loading…';
  try {
    const data = await fetch('/api/history/score-benchmarks').then(r => r.json());
    if (!data.sufficient) {
      if (statusEl) statusEl.textContent = `Need ${5 - (data.count || 0)} more scored entries.`;
      return;
    }
    if (data.estCashLine != null) {
      const el = document.getElementById('sim-cash-line');
      if (el) el.value = Math.round(data.estCashLine);
    }
    if (data.scorePercentiles?.p90 != null) {
      const el = document.getElementById('sim-top10-line');
      if (el) el.value = Math.round(data.scorePercentiles.p90);
    }
    if (data.estWinLine != null) {
      const el = document.getElementById('sim-win-line');
      if (el) el.value = Math.round(data.estWinLine);
    }
    const n = data.benchmarkMeta?.cashSampleSize ?? data.scorePercentiles?.p50 ?? 0;
    if (statusEl) statusEl.textContent = `Lines from ${data.entriesWithResults || ''} scored entries.`;
    STATE.simBenchmarksLoaded = true;
  } catch {
    if (statusEl) statusEl.textContent = 'History fetch failed.';
  }
}

function renderEdgeCard(profile) {
  const el = document.getElementById('edge-card');
  if (!el) return;
  if (!profile) { el.style.display = 'none'; return; }

  const roiColor = profile.roi == null ? 'var(--ts)'
    : profile.roi > 25  ? '#22c55e'
    : profile.roi > 5   ? '#84cc16'
    : profile.roi > -5  ? '#f59e0b'
    : '#ef4444';

  const fmt   = (v, d=1) => v != null ? v.toFixed(d) : '—';
  const pct   = v => v != null ? fmt(v) + '%' : '—';
  const sgn   = v => v > 0 ? '+' : '';
  const roiStr  = profile.roi != null ? sgn(profile.roi) + fmt(profile.roi) + '%' : '—';
  const evStr   = profile.ev  != null ? '$' + fmt(profile.ev, 2) + ' avg payout on $' + profile.entryFee + ' entry' : '';

  const ownColor  = profile.ownDelta > 5 ? '#22c55e' : profile.ownDelta > 0 ? '#84cc16' : profile.ownDelta > -3 ? '#f59e0b' : '#ef4444';
  const ownLabel  = profile.ownDelta > 0
    ? sgn(profile.ownDelta) + fmt(profile.ownDelta) + '% below chalk (contrarian edge)'
    : fmt(-profile.ownDelta) + '% above chalk (chalk-heavy)';
  const dupeColor = { Unique: '#22c55e', Low: '#84cc16', Med: '#f59e0b', High: '#ef4444' }[profile.dupeRisk] || 'var(--ts)';
  const levColor  = profile.levDelta > 1 ? '#22c55e' : profile.levDelta > 0 ? '#84cc16' : '#f59e0b';

  const rowEdge = (v, goodThresh, badThresh) => {
    const color = v > goodThresh ? '#22c55e' : v > badThresh ? '#f59e0b' : '#ef4444';
    return `<span style="color:${color}">${sgn(v)}${fmt(v)}</span>`;
  };

  el.style.display = 'block';
  el.innerHTML = `
    <div style="display:flex;gap:6px;align-items:center;margin-bottom:12px">
      <span style="font-size:13px;font-weight:700;color:var(--tp)">Know Your Edge</span>
      <span style="font-size:11px;color:var(--ts)">${profile.payoutType === 'top20' ? 'GPP Top 20%' : profile.payoutType === 'top10' ? 'Large Field Top 10%' : profile.payoutType === 'winner' ? 'Winner Take Most' : 'Double-Up'} · ${Number(profile.fieldSize).toLocaleString()} entries · $${profile.entryFee}</span>
    </div>
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px;align-items:flex-start">
      <div style="min-width:100px">
        <div style="font-size:10px;color:var(--ts);margin-bottom:2px;text-transform:uppercase;letter-spacing:.04em">Est. GPP ROI</div>
        <div style="font-size:38px;font-weight:800;color:${roiColor};line-height:1">${roiStr}</div>
        <div style="font-size:10px;color:var(--ts);margin-top:3px">${evStr}</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;flex:1">
        <div style="background:var(--bp);border:0.5px solid var(--brd);border-radius:6px;padding:8px 12px;min-width:90px;text-align:center">
          <div style="font-size:20px;font-weight:700;color:${ownColor}">${pct(profile.lineupAvgOwn)}</div>
          <div style="font-size:10px;color:var(--ts)">avg ownership</div>
          <div style="font-size:10px;color:${ownColor};margin-top:2px">${ownLabel}</div>
        </div>
        <div style="background:var(--bp);border:0.5px solid var(--brd);border-radius:6px;padding:8px 12px;min-width:90px;text-align:center">
          <div style="font-size:20px;font-weight:700;color:${levColor}">${fmt(profile.lineupLev)}</div>
          <div style="font-size:10px;color:var(--ts)">leverage score</div>
          <div style="font-size:10px;color:${levColor};margin-top:2px">${sgn(profile.levDelta)}${fmt(profile.levDelta)} vs chalk</div>
        </div>
        <div style="background:var(--bp);border:0.5px solid var(--brd);border-radius:6px;padding:8px 12px;min-width:90px;text-align:center">
          <div style="font-size:20px;font-weight:700;color:${dupeColor}">${profile.dupeRisk}</div>
          <div style="font-size:10px;color:var(--ts)">lineup uniqueness</div>
          <div style="font-size:10px;color:var(--ts);margin-top:2px">${fmt(profile.dupesExpected, 1)} expected dupes</div>
        </div>
      </div>
    </div>
    <div style="font-size:11px;font-weight:600;color:var(--ts);margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em">vs Chalk Baseline</div>
    <div style="overflow-x:auto">
      <table style="font-size:12px">
        <thead><tr>
          <th style="text-align:left;color:var(--ts);font-weight:500">Stat</th>
          <th style="text-align:right;color:var(--tp)">Your Lineup</th>
          <th style="text-align:right;color:var(--ts)">Chalk Entry</th>
          <th style="text-align:right;color:var(--ts)">Your Edge</th>
        </tr></thead>
        <tbody>
          <tr>
            <td style="color:var(--ts)">Projected Score</td>
            <td style="text-align:right;font-weight:600">${fmt(profile.lineupProj)} pts</td>
            <td style="text-align:right;color:var(--ts)">${fmt(profile.chalkProj)} pts</td>
            <td style="text-align:right">${rowEdge(profile.projDelta, 3, 0)}</td>
          </tr>
          <tr>
            <td style="color:var(--ts)">Avg Hitter Own%</td>
            <td style="text-align:right;font-weight:600">${pct(profile.lineupBatOwn)}</td>
            <td style="text-align:right;color:var(--ts)">${pct(profile.chalkBatOwn)}</td>
            <td style="text-align:right">${rowEdge(profile.chalkBatOwn - profile.lineupBatOwn, 5, 0)}</td>
          </tr>
          <tr>
            <td style="color:var(--ts)">Avg Pitcher Own%</td>
            <td style="text-align:right;font-weight:600">${pct(profile.lineupPitOwn)}</td>
            <td style="text-align:right;color:var(--ts)">${pct(profile.chalkPitOwn)}</td>
            <td style="text-align:right">${rowEdge(profile.chalkPitOwn - profile.lineupPitOwn, 10, 0)}</td>
          </tr>
          <tr>
            <td style="color:var(--ts)">Leverage Score</td>
            <td style="text-align:right;font-weight:600">${fmt(profile.lineupLev)}</td>
            <td style="text-align:right;color:var(--ts)">${fmt(profile.chalkLev)}</td>
            <td style="text-align:right">${rowEdge(profile.levDelta, 1, 0)}</td>
          </tr>
          <tr>
            <td style="color:var(--ts)">Lineup Uniqueness</td>
            <td style="text-align:right;font-weight:600;color:${dupeColor}">${profile.dupeRisk}</td>
            <td style="text-align:right;color:var(--ts)">Med–High</td>
            <td style="text-align:right;color:${dupeColor};font-size:11px">${(profile.pUnique * 100).toFixed(0)}% chance unique</td>
          </tr>
        </tbody>
      </table>
    </div>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BACKTESTING TAB
// ═══════════════════════════════════════════════════════════════════════════════
async function loadHistory() {
  try {
    const [history, summary] = await Promise.all([
      fetch('/api/history').then(r => r.json()),
      fetch('/api/history/summary').then(r => r.json())
    ]);
    STATE.historyData = history;
    // Rebuild historical pair correlations from entries that have player actuals
    const withActuals = history.filter(h => h.playerActuals && Object.keys(h.playerActuals).length >= 2);
    if (withActuals.length >= 3) {
      Engine.buildPairCorrelations(withActuals);
      // Fix #3 — calibrate the simulator's boom/bust tail rates from actual outcomes
      // instead of the hardcoded 3%/4% defaults. Shrinks toward defaults at low sample.
      if (Engine.computeTailRatesFromHistory && Engine.setTailRates && STATE.POOL.length) {
        const tail = Engine.computeTailRatesFromHistory(withActuals, STATE.POOL);
        Engine.setTailRates(tail);
        STATE.tailRates = tail;
      }
    }
    renderBacktestPanel(history, summary);
  } catch (e) {
    console.error('Failed to load history:', e);
    showToast('Could not load lineup history: ' + (e.message || e), 'warn', 5000);
  }
}

function renderBacktestPanel(history, summary) {
  const summaryEl = document.getElementById('backtest-summary');
  const historyEl = document.getElementById('backtest-history');

  // Summary cards
  const cashRateColor = summary.cashRate !== null && summary.breakEven
    ? (summary.cashRate >= summary.breakEven.double_up.requiredCashRate ? 'var(--tsu)' : 'var(--td)')
    : 'var(--tp)';
  const finishPctColor = summary.avgFinishPct !== null
    ? (summary.avgFinishPct >= 50 ? 'var(--tsu)' : summary.avgFinishPct >= 20 ? 'var(--tw)' : 'var(--td)')
    : 'var(--tp)';

  summaryEl.innerHTML = `<div class="mc-row">
    <div class="mc"><div class="mc-l">Total Entries</div><div class="mc-v">${summary.totalEntries}</div></div>
    <div class="mc"><div class="mc-l">Net Profit</div><div class="mc-v" style="color:${summary.netProfit >= 0 ? 'var(--tsu)' : 'var(--td)'}">$${summary.netProfit.toFixed(0)}</div></div>
    <div class="mc"><div class="mc-l">ROI</div><div class="mc-v" style="color:${summary.roi >= 0 ? 'var(--tsu)' : 'var(--td)'}">${summary.roi.toFixed(1)}%</div></div>
    <div class="mc"><div class="mc-l">Cash Rate</div><div class="mc-v" style="color:${cashRateColor}">${summary.cashRate !== null ? summary.cashRate.toFixed(1) + '%' : '—'}</div></div>
    <div class="mc"><div class="mc-l">Avg Finish %ile</div><div class="mc-v" style="color:${finishPctColor}">${summary.avgFinishPct !== null ? summary.avgFinishPct.toFixed(1) + '%' : '—'}</div></div>
    <div class="mc"><div class="mc-l">Proj Accuracy</div><div class="mc-v">${summary.projectionAccuracy.toFixed(1)}%</div></div>
  </div>
  ${summary.breakEven ? `<div style="margin-top:8px;padding:8px 10px;background:var(--bs);border-radius:var(--r);font-size:11px;color:var(--tt)">
    <strong style="color:var(--tp)">Break-even (10% rake):</strong>
    GPP top 20%: <strong>${summary.breakEven.gpp_top20.requiredCashRate}%</strong> cash rate required ·
    Double-up: <strong>${summary.breakEven.double_up.requiredCashRate}%</strong> required
    ${summary.cashRate !== null ? `· Your rate: <strong style="color:${cashRateColor}">${summary.cashRate.toFixed(1)}%</strong>` : ''}
  </div>` : ''}`;

  // Save current lineup button
  const todayStr = new Date().toISOString().substring(0, 10);
  const saveHtml = `<div style="margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
    <select id="bt-contest" style="font-size:12px;padding:5px 8px;border-radius:var(--r);border:0.5px solid var(--brd-s);background:var(--bp);color:var(--tp)">
      <option value="GPP">GPP</option><option value="Cash">Cash</option><option value="Single">Single Entry</option>
    </select>
    <input type="date" id="bt-slate-date" value="${todayStr}" style="font-size:12px;padding:5px 8px;border-radius:var(--r);border:0.5px solid var(--brd-s);background:var(--bp);color:var(--tp)" title="Slate date — must match the date you use when loading actuals">
    <input type="number" id="bt-buyin" placeholder="Buy-in $" style="width:80px;font-size:12px;padding:5px 8px;border-radius:var(--r);border:0.5px solid var(--brd-s);background:var(--bp);color:var(--tp)">
    <input type="number" id="bt-finish" placeholder="Finish #" style="width:80px;font-size:12px;padding:5px 8px;border-radius:var(--r);border:0.5px solid var(--brd-s);background:var(--bp);color:var(--tp)" title="Your finish position (e.g. 42)">
    <input type="number" id="bt-entries" placeholder="# Entries" style="width:90px;font-size:12px;padding:5px 8px;border-radius:var(--r);border:0.5px solid var(--brd-s);background:var(--bp);color:var(--tp)" title="Total entries in the contest">
    <button class="btn-g" onclick="saveLineupToHistory()">Save Current Lineup</button>
  </div>`;

  // ── Bulk slate results entry ────────────────────────────────────────────────
  // Group history entries by slate date to show what's missing results data.
  const slateDates = [...new Set(history.map(h => h.slateDate || '').filter(Boolean))].sort().reverse();
  const slateStats = {};
  slateDates.forEach(d => {
    const entries = history.filter(h => h.slateDate === d);
    slateStats[d] = {
      total: entries.length,
      missingBuyin: entries.filter(h => !h.buyin).length,
      missingWinnings: entries.filter(h => h.winnings === null).length,
    };
  });
  const bulkHtml = slateDates.length ? `
  <div style="margin-bottom:14px;padding:12px 14px;background:var(--bs);border-radius:var(--rl)">
    <div class="sec-label" style="margin-bottom:8px">Quick Slate Results Entry</div>
    <div style="font-size:11px;color:var(--tt);margin-bottom:8px">Set buy-in and/or winnings for all lineups on a slate at once.</div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <select id="bulk-slate-date" style="font-size:12px;padding:5px 8px;border-radius:var(--r);border:0.5px solid var(--brd-s);background:var(--bp);color:var(--tp)">
        ${slateDates.map(d => {
          const s = slateStats[d];
          const warn = s.missingBuyin > 0 ? ` — ${s.missingBuyin} missing buy-in` : '';
          return `<option value="${escAttr(d)}">${esc(d)} (${s.total} entries${warn})</option>`;
        }).join('')}
      </select>
      <label style="font-size:12px;color:var(--ts);display:flex;align-items:center;gap:4px">
        Buy-in $
        <input type="number" id="bulk-buyin" step="0.01" min="0" placeholder="e.g. 1.00"
          style="width:80px;font-size:12px;padding:5px 8px;border-radius:var(--r);border:0.5px solid var(--brd-s);background:var(--bp);color:var(--tp)">
      </label>
      <label style="font-size:12px;color:var(--ts);display:flex;align-items:center;gap:4px">
        Total won $
        <input type="number" id="bulk-winnings" step="0.01" min="0" placeholder="0 if none"
          style="width:80px;font-size:12px;padding:5px 8px;border-radius:var(--r);border:0.5px solid var(--brd-s);background:var(--bp);color:var(--tp)"
          title="Leave blank to only update buy-ins. Set to 0 to record a losing slate.">
      </label>
      <button class="btn-g" onclick="applyBulkSlateResults()">Apply to Slate</button>
    </div>
    <div id="bulk-result-msg" style="margin-top:6px;font-size:11px;color:var(--tsu)"></div>
  </div>` : '';

  // ── DK Contest CSV Import ───────────────────────────────────────────────────────────────────
  const importHtml = `
  <div style="margin-bottom:14px;padding:12px 14px;background:var(--bs);border-radius:var(--rl)">
    <div class="sec-label" style="margin-bottom:6px">Import DraftKings Contest History</div>
    <div style="font-size:11px;color:var(--tt);margin-bottom:8px">
      Download from DraftKings: <strong>Account → My Contests → Past → Export CSV</strong>.
      Matches each row to a saved lineup by date + score, then fills in placement, payout, and contest ID.
    </div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <input type="file" id="dk-contest-csv-input" accept=".csv" style="font-size:12px;color:var(--ts)">
      <button class="btn-g" onclick="importDKContestCSV()">Import CSV</button>
      <button class="btn" onclick="fetchAllContestDetails()" title="Fetch contest metadata and winning scores from DraftKings for all entries with a Contest ID">Fetch DK Details</button>
    </div>
    <div id="dk-contest-status" style="margin-top:6px;font-size:11px;min-height:16px"></div>
  </div>`;

  // History list
  let histHtml = '';
  if (history.length) {
    histHtml = `<div style="max-height:500px;overflow-y:auto"><table><thead><tr><th>Date</th><th>Contest</th><th>Proj</th><th>Actual</th><th>Accuracy</th><th>Place</th><th>Field</th><th>Buy-in</th><th>Won</th><th>ROI</th><th></th></tr></thead><tbody>
    ${history.slice(0, 50).map(h => {
      const roi = h.buyin && h.winnings !== null ? ((h.winnings - h.buyin) / h.buyin * 100).toFixed(0) + '%' : '\u2014';
      const roiColor = h.winnings > h.buyin ? 'var(--tsu)' : h.winnings < h.buyin ? 'var(--td)' : 'var(--ts)';
      const accuracy = h.actualPts && h.projectedPts ? (h.actualPts / h.projectedPts * 100).toFixed(0) + '%' : '\u2014';
      const accColor = h.actualPts && h.projectedPts ? (h.actualPts >= h.projectedPts * 0.95 ? 'var(--tsu)' : h.actualPts >= h.projectedPts * 0.80 ? 'var(--tw)' : 'var(--td)') : 'var(--ts)';
      const hasPlayerActuals = h.playerActuals && Object.keys(h.playerActuals).length > 0;
      const playerActualsBadge = hasPlayerActuals ? `<span class="pill psu" style="font-size:9px;margin-left:4px" title="${Object.keys(h.playerActuals).length} player scores loaded">✓ ${Object.keys(h.playerActuals).length}p</span>` : '';
      const displayDate = h.slateDate || new Date(h.date).toLocaleDateString();
      // Finish percentile
      const finishPct = h.finish && h.entries ? (h.finish / h.entries * 100).toFixed(1) : null;
      const finishColor = finishPct != null ? (parseFloat(finishPct) <= 5 ? 'var(--tsu)' : parseFloat(finishPct) <= 20 ? 'var(--tw)' : 'var(--td)') : 'var(--ts)';
      const finishDisplay = h.finish
        ? `<span style="color:${finishColor};font-weight:500">${h.finish}</span>${finishPct != null ? `<span style="font-size:9px;color:var(--tt);margin-left:2px">(${finishPct}%)</span>` : ''}`
        : `<input type="number" step="1" value="" placeholder="—" style="width:52px;font-size:11px;padding:2px 4px;border-radius:4px;border:0.5px solid var(--brd-s);background:var(--bp);color:var(--tp)" onchange="updateHistoryField('${h.id}','finish',this.value)">`;
      const fieldDisplay = h.entries ? `<span style="font-size:11px;color:var(--ts)">${h.entries.toLocaleString()}</span>` : '—';
      const contestBadge = h.contestId
        ? `<span class="pill" style="font-size:9px;background:var(--bs);color:var(--tt);cursor:pointer;margin-left:2px" onclick="fetchContestDetails('${escAttr(h.contestId)}','${h.id}')" title="Fetch contest details from DraftKings">#${esc(h.contestId)}</span>`
        : '';
      return `<tr>
        <td style="font-size:11px">${esc(displayDate)}${playerActualsBadge}${contestBadge ? '<br>'+contestBadge : ''}</td>
        <td><span class="pill pg">${esc(h.contest)}</span>${h.contestTitle ? `<div style="font-size:9px;color:var(--tt);max-width:120px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${escAttr(h.contestTitle)}">${esc(h.contestTitle)}</div>` : ''}</td>
        <td>${h.projectedPts?.toFixed(1) || '\u2014'}</td>
        <td><input type="number" step="0.1" value="${h.actualPts || ''}" placeholder="\u2014" style="width:60px;font-size:11px;padding:2px 4px;border-radius:4px;border:0.5px solid var(--brd-s);background:var(--bp);color:var(--tp)" onchange="updateHistoryField('${h.id}','actualPts',this.value)"></td>
        <td style="color:${accColor};font-size:11px">${accuracy}</td>
        <td style="white-space:nowrap">${finishDisplay}</td>
        <td>${fieldDisplay}</td>
        <td><input type="number" step="0.01" value="${h.buyin || ''}" placeholder="—" style="width:55px;font-size:11px;padding:2px 4px;border-radius:4px;border:0.5px solid var(--brd-s);background:var(--bp);color:var(--tp)" onchange="updateHistoryField('${h.id}','buyin',this.value)"></td>
        <td><input type="number" step="0.01" value="${h.winnings || ''}" placeholder="\u2014" style="width:70px;font-size:11px;padding:2px 4px;border-radius:4px;border:0.5px solid var(--brd-s);background:var(--bp);color:var(--tp)" onchange="updateHistoryField('${h.id}','winnings',this.value)"></td>
        <td style="color:${roiColor};font-weight:500">${roi}</td>
        <td style="white-space:nowrap">
          ${hasPlayerActuals ? `<button class="btn" style="padding:2px 6px;font-size:10px" onclick="toggleAttribution('${h.id}')" title="Score attribution breakdown">📊</button>` : ''}
          <button class="btn" style="padding:2px 6px;font-size:10px" onclick="toggleOwnershipEntry('${h.id}')" title="Enter actual ownership">own%</button>
          <button class="btn" style="padding:2px 6px;font-size:10px;color:var(--td)" onclick="deleteHistoryEntry('${h.id}')">x</button>
        </td>
      </tr>
      <tr id="attr-row-${h.id}" style="display:none"><td colspan="11"><div id="attr-content-${h.id}" style="padding:6px 8px;background:var(--bs);border-radius:var(--r);font-size:11px;color:var(--tt)">Loading...</div></td></tr>
      <tr id="own-row-${h.id}" style="display:none"><td colspan="11">
        <div style="padding:6px 8px;background:var(--bs);border-radius:var(--r);font-size:11px">
          <strong style="color:var(--tt)">Actual Ownership %</strong>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">
            ${(h.lineup || []).filter(p => (p.own || 0) > 0).map(p => {
              const actual = h.actualOwnership?.[p.name];
              return `<label style="display:flex;align-items:center;gap:2px">
                <span style="color:var(--ts)">${esc(p.name.split(' ').pop())}(${(p.own||0).toFixed(0)}%)</span>
                <input type="number" step="0.1" min="0" max="100" value="${actual != null ? actual : ''}" placeholder="—"
                  style="width:48px;font-size:10px;padding:2px 3px;border-radius:3px;border:0.5px solid var(--brd-s);background:var(--bp);color:var(--tp)"
                  data-hist-id="${h.id}" data-player="${esc(p.name)}" class="own-actual-input">
              </label>`;
            }).join('')}
          </div>
          <button class="btn" style="margin-top:4px;padding:2px 8px;font-size:10px" onclick="saveActualOwnership('${h.id}')">Save Ownership</button>
          ${h.actualOwnership ? '<span style="margin-left:6px;color:var(--tsu);font-size:10px">✓ saved</span>' : ''}
        </div>
      </td></tr>`;
    }).join('')}</tbody></table></div>`;
  } else {
    histHtml = '<div class="empty" style="padding:20px">No lineup history yet. Save lineups to track performance.</div>';
  }

  // History management settings
  const hs = summary.historySettings || { maxSlates: 30, stripPoolAfterSlates: 5 };
  const mgmtHtml = `<div style="margin-top:16px;padding:12px 14px;background:var(--bs);border-radius:var(--rl)">
    <div class="sec-label" style="margin-bottom:8px">History Management</div>
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;font-size:12px">
      <span style="color:var(--ts)">${summary.totalEntries} entries across ${summary.uniqueSlates || '?'} slate${(summary.uniqueSlates||0)!==1?'s':''}</span>
      <label style="display:flex;align-items:center;gap:4px">Keep last
        <input type="number" id="hist-max-slates" value="${hs.maxSlates}" min="1" max="365" style="width:52px;font-size:12px;padding:3px 6px;border-radius:var(--r);border:0.5px solid var(--brd-s);background:var(--bp);color:var(--tp)">
        slates</label>
      <label style="display:flex;align-items:center;gap:4px">Strip pool data after
        <input type="number" id="hist-strip-pool" value="${hs.stripPoolAfterSlates}" min="1" max="365" style="width:52px;font-size:12px;padding:3px 6px;border-radius:var(--r);border:0.5px solid var(--brd-s);background:var(--bp);color:var(--tp)">
        slates</label>
      <button class="btn" onclick="saveHistorySettings()">Save Settings</button>
      <button class="btn" style="color:var(--tw)" onclick="pruneHistoryNow()">Prune Now</button>
    </div>
  </div>`;

  historyEl.innerHTML = saveHtml + importHtml + bulkHtml + histHtml + mgmtHtml;
}

async function saveHistorySettings() {
  const maxSlates = parseInt(document.getElementById('hist-max-slates')?.value) || 30;
  const stripPoolAfterSlates = parseInt(document.getElementById('hist-strip-pool')?.value) || 5;
  try {
    const r = await fetch('/api/history/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxSlates, stripPoolAfterSlates })
    });
    const d = await r.json();
    showToast(`Settings saved — ${d.entriesAfterPrune} entries retained`, 'success');
    loadHistory();
  } catch (e) { showToast('Failed to save settings', 'error'); }
}

async function pruneHistoryNow() {
  try {
    const r = await fetch('/api/history/prune', { method: 'POST' });
    const d = await r.json();
    showToast(`Pruned ${d.removed} entries (${d.before} → ${d.after})`, 'success');
    loadHistory();
  } catch (e) { showToast('Prune failed', 'error'); }
}

// ── DK Contest CSV Import ─────────────────────────────────────────────────────

async function importDKContestCSV() {
  const input = document.getElementById('dk-contest-csv-input');
  const statusEl = document.getElementById('dk-contest-status');
  if (!input?.files?.length) { showToast('Select a CSV file first', 'error'); return; }
  const file = input.files[0];
  const csv = await file.text();
  if (statusEl) statusEl.textContent = 'Importing…';
  try {
    const r = await fetch('/api/contests/import-csv', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csv }),
    });
    const d = await r.json();
    if (!r.ok) { showToast(d.error || 'Import failed', 'error'); if (statusEl) statusEl.textContent = d.error || 'Import failed'; return; }
    const msg = `Imported ${d.rowsParsed} rows — ${d.matched} matched to saved lineups, ${d.created} new stub entries${d.skipped ? ', ' + d.skipped + ' skipped' : ''}.`;
    if (statusEl) statusEl.textContent = msg;
    showToast(msg, 'success');
    loadHistory();

    // #5: Auto-update contest size to the most recently imported value so the
    // ownership leverage / simROI calculations match the field the user actually plays in.
    if (d.suggestedContestSize && d.suggestedContestSize > 1) {
      const portInput = document.getElementById('port-contest-size');
      const prevSize = portInput ? parseInt(portInput.value) : STATE.contestSize;
      if (prevSize !== d.suggestedContestSize) {
        if (portInput) portInput.value = d.suggestedContestSize;
        STATE.contestSize = d.suggestedContestSize;
        saveSession();
        showToast(`Contest size auto-updated to ${d.suggestedContestSize.toLocaleString()} (from imported contest ${d.suggestedContestDate || ''}).`, 'info', 5000);
      }
    }
  } catch (e) {
    showToast('Import error: ' + e.message, 'error');
    if (statusEl) statusEl.textContent = 'Error: ' + e.message;
  }
}

// Fetch DK contest metadata for a single entry (called from the contestId badge in the history table)
async function fetchContestDetails(contestId, entryId) {
  const statusEl = document.getElementById('dk-contest-status') || document.getElementById('dk-import-status');
  if (statusEl) statusEl.textContent = `Fetching contest ${contestId}…`;
  try {
    const r = await fetch(`/api/contests/${encodeURIComponent(contestId)}`);
    const d = await r.json();
    if (!r.ok) { showToast(d.error || 'Fetch failed', 'error'); return; }
    if (!d.fetched) { showToast('DraftKings did not return contest data for #' + contestId, 'error'); return; }

    // Patch the history entry with fetched data
    const patch = {};
    if (d.entries && !patch.entries) patch.entries = d.entries;
    if (d.winningScore)  patch.contestWinScore  = d.winningScore;
    if (d.cashLineScore) patch.contestCashScore = d.cashLineScore;
    if (d.title)         patch.contestTitle      = d.title;
    if (d.prizePool)     patch.contestPrizePool  = d.prizePool;

    if (Object.keys(patch).length && entryId) {
      await fetch(`/api/history/${encodeURIComponent(entryId)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
    }

    let msg = `Contest #${contestId}`;
    if (d.title) msg += `: ${d.title}`;
    if (d.entries) msg += ` · ${d.entries.toLocaleString()} entries`;
    if (d.winningScore) msg += ` · Winner: ${d.winningScore.toFixed(1)} pts`;
    if (d.cashLineScore) msg += ` · Cash line ~${d.cashLineScore.toFixed(1)} pts`;

    if (statusEl) statusEl.textContent = msg;
    showToast(msg, 'success');
    loadHistory();
  } catch (e) {
    showToast('Fetch error: ' + e.message, 'error');
    if (statusEl) statusEl.textContent = 'Error: ' + e.message;
  }
}

// Fetch DK contest details for ALL history entries that have a contestId
async function fetchAllContestDetails() {
  const statusEl = document.getElementById('dk-contest-status') || document.getElementById('dk-import-status');
  const history = STATE.historyData || [];
  const ids = [...new Set(history.filter(h => h.contestId).map(h => h.contestId))];
  if (!ids.length) { showToast('No contest IDs found — import your DK CSV first', 'error'); return; }
  if (statusEl) statusEl.textContent = `Fetching details for ${ids.length} contest(s)…`;

  let done = 0, succeeded = 0;
  for (const contestId of ids) {
    const entry = history.find(h => h.contestId === contestId);
    try {
      const r = await fetch(`/api/contests/${encodeURIComponent(contestId)}`);
      const d = await r.json();
      if (d.fetched) {
        const patch = {};
        if (d.entries)       patch.entries           = d.entries;
        if (d.winningScore)  patch.contestWinScore   = d.winningScore;
        if (d.cashLineScore) patch.contestCashScore  = d.cashLineScore;
        if (d.title)         patch.contestTitle       = d.title;
        if (d.prizePool)     patch.contestPrizePool   = d.prizePool;
        if (Object.keys(patch).length && entry) {
          await fetch(`/api/history/${encodeURIComponent(entry.id)}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
          });
        }
        succeeded++;
      }
    } catch (e) { /* skip failed contest */ }
    done++;
    if (statusEl) statusEl.textContent = `Fetching… ${done}/${ids.length} contests`;
    // Small delay to avoid hammering DK
    await new Promise(res => setTimeout(res, 300));
  }

  const msg = `Fetched details for ${succeeded}/${ids.length} contests.`;
  if (statusEl) statusEl.textContent = msg;
  showToast(msg, 'success');
  loadHistory();
}

function deriveSlateDate() {
  // Try to infer the game date from player game times in the pool
  // Game times are strings like "07:10PM ET" - use today unless it's early morning
  const now = new Date();
  const hour = now.getUTCHours() - 5; // rough ET offset
  // If it's 0-5 AM ET, the slate was yesterday (post-midnight session)
  if (hour < 0 || hour < 5) {
    const yesterday = new Date(now.getTime() - 86400000);
    return yesterday.toISOString().substring(0, 10);
  }
  return now.toISOString().substring(0, 10);
}

async function saveLineupToHistory() {
  const players = STATE.lineup.filter(Boolean);
  if (!players.length) return;
  const contest = document.getElementById('bt-contest').value;
  const buyin = parseFloat(document.getElementById('bt-buyin').value) || 0;
  const finish = parseInt(document.getElementById('bt-finish')?.value) || null;
  const entries = parseInt(document.getElementById('bt-entries')?.value) || null;
  const projectedPts = players.reduce((s, p) => s + (p.median || 0), 0);
  const projectedOwn = players.reduce((s, p) => s + (p.own || 0), 0);
  const salary = players.reduce((s, p) => s + p.salary, 0);
  const slateDate = document.getElementById('bt-slate-date')?.value || deriveSlateDate();

  // Capture active calibration at save time so the analysis endpoint can
  // normalize medians back to raw ROO values for an apples-to-apples comparison.
  const activeCal = Engine.getCalibration();

  // Per-player snapshot includes all projection components for Phase 3 analysis
  const lineupSnapshot = players.map(p => ({
    name: p.name, team: p.team, pos: p.dkPos, salary: p.salary,
    median: p.median || 0, floor: p.floor || 0, ceiling: p.ceiling || 0,
    own: p.own || 0, order: p.order || 0, hand: p.hand || ''
  }));

  // Full pool snapshot captures all available projections at lineup creation time
  const poolSnapshot = STATE.POOL.map(p => ({
    name: p.name, team: p.team, pos: p.dkPos, salary: p.salary,
    median: p.median || 0, floor: p.floor || 0, ceiling: p.ceiling || 0,
    own: p.own || 0, order: p.order || 0
  }));

  // Capture per-source projection snapshots so /api/source-quality/update can
  // compare each file's raw projections against actuals independently.
  // Each entry is { name: filename, projections: { playerName: medianProjection } }
  const sourcesSnapshot = STATE.ROO_SOURCES
    .map((src, i) => {
      if (!src || !src.data || !src.data.length) return null;
      const projections = {};
      src.data.forEach(p => { if (p.name && p.median > 0) projections[p.name] = p.median; });
      return { name: src.fname, weight: STATE.rooWeights[i], projections };
    })
    .filter(Boolean);
  // Include internal projections as a source for quality tracking (when no ROO was loaded)
  const internalPlayers = STATE.POOL.filter(p => p.hasInternalProj && !p.hasRoo && p.median > 0);
  if (internalPlayers.length > 0) {
    const projections = {};
    internalPlayers.forEach(p => { projections[p.name] = p.median; });
    sourcesSnapshot.push({ name: 'Internal (season rates)', weight: 100, projections });
  }

  try {
    await fetch('/api/history', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contest, buyin, finish, entries, projectedPts, projectedOwn, salary, slateDate,
        lineup: lineupSnapshot,
        poolSnapshot,
        sources: sourcesSnapshot,
        calibBatterScale: activeCal.batterScale || 1.0,
        calibPitcherScale: activeCal.pitcherScale || 1.0
      })
    });
    loadHistory();
  } catch (e) {
    console.error('Save history failed:', e);
    // CRITICAL: silent failure here means the user's lineup wasn't saved for future calibration.
    showToast('Failed to save lineup to history: ' + (e.message || e) + '. Click Save to History to retry.', 'warn', 7000);
  }
}

async function updateHistoryField(id, field, value) {
  try {
    const body = {};
    body[field] = parseFloat(value) || null;
    await fetch('/api/history/' + id, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    loadHistory();
  } catch (e) {
    console.error('Update history failed:', e);
    showToast('Failed to update history entry: ' + (e.message || e), 'warn', 5000);
  }
}

// Bulk-set buy-in (and optionally winnings) for all entries on a slate date.
// Winnings are distributed evenly across entries for the entered total.
async function applyBulkSlateResults() {
  const date = document.getElementById('bulk-slate-date')?.value;
  const buyin = parseFloat(document.getElementById('bulk-buyin')?.value);
  const winningsRaw = document.getElementById('bulk-winnings')?.value.trim();
  const msgEl = document.getElementById('bulk-result-msg');

  if (!date) { if (msgEl) msgEl.textContent = 'Select a slate date.'; return; }
  if (!buyin && winningsRaw === '') { if (msgEl) msgEl.textContent = 'Enter a buy-in amount or winnings (or both).'; return; }

  const history = STATE.historyData || [];
  const targets = history.filter(h => (h.slateDate || '') === date);
  if (!targets.length) { if (msgEl) msgEl.textContent = 'No entries found for that date.'; return; }

  if (msgEl) msgEl.textContent = `Updating ${targets.length} entries...`;

  // Distribute total winnings evenly across entries (e.g. $20 total / 20 entries = $1 each).
  // If winnings field is blank, only update buy-in.
  const hasWinnings = winningsRaw !== '';
  const totalWinnings = hasWinnings ? (parseFloat(winningsRaw) || 0) : null;
  const perEntryWinnings = hasWinnings ? parseFloat((totalWinnings / targets.length).toFixed(4)) : null;

  try {
    await Promise.all(targets.map(entry => {
      const body = {};
      if (buyin) body.buyin = buyin;
      if (hasWinnings) body.winnings = perEntryWinnings;
      return fetch(`/api/history/${entry.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    }));
    const wMsg = hasWinnings ? `, $${totalWinnings.toFixed(2)} total won ($${perEntryWinnings?.toFixed(2)} each)` : '';
    if (msgEl) { msgEl.style.color = 'var(--tsu)'; msgEl.textContent = `Updated ${targets.length} entries — buy-in $${buyin || '—'}${wMsg}`; }
    loadHistory();
  } catch (e) {
    if (msgEl) { msgEl.style.color = 'var(--td)'; msgEl.textContent = 'Failed to update entries.'; }
  }
}

// ── DK Contest Results Import ─────────────────────────────────────────────────
// Parses a DraftKings contest results CSV (My Contests → Export) and auto-populates
// finish position, actual points, and winnings for matching saved lineups.
//
// Supported DK formats:
//   Full entry export:    Entry Name, Entry ID, Contest Name, ..., Place, Points, Winnings, Lineup
//   Contest results:      Rank, EntryId, EntryName, TimeRemaining, Points, Lineup
//
// Lineup column: "SP Max Scherzer  C Willson Contreras  1B Pete Alonso  ..."
// Players matched by normalised name overlap (≥7/10).

function parseDKResultsCSV(text) {
  // Minimal CSV parser that handles quoted fields containing commas.
  function parseCSVLine(line) {
    const fields = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === ',' && !inQ) { fields.push(cur); cur = ''; continue; }
      cur += ch;
    }
    fields.push(cur);
    return fields.map(f => f.trim());
  }

  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ''));

  // Locate required columns by fuzzy header match
  const col = name => {
    const idx = headers.findIndex(h => h.includes(name));
    return idx >= 0 ? idx : -1;
  };

  const colPlace      = col('place') >= 0 ? col('place') : col('rank');
  const colPoints     = col('points');
  const colWinnings   = col('winning');
  const colLineup     = col('lineup');
  const colContest    = col('contestname') >= 0 ? col('contestname') : col('contest');
  const colDate       = col('conteststart') >= 0 ? col('conteststart') : col('datecreated');
  const colContestId  = col('contestkey') >= 0 ? col('contestkey') : col('contestid') >= 0 ? col('contestid') : -1;
  const colEntries    = col('entriesincontest') >= 0 ? col('entriesincontest') : col('totalentries') >= 0 ? col('totalentries') : -1;

  if (colPoints < 0 || colLineup < 0) return []; // Can't do anything useful

  const entries = [];
  for (let i = 1; i < lines.length; i++) {
    const row = parseCSVLine(lines[i]);
    if (row.length < 3) continue;

    const placeRaw    = colPlace >= 0      ? row[colPlace]      : '';
    const pointsRaw   = colPoints >= 0     ? row[colPoints]     : '';
    const winRaw      = colWinnings >= 0   ? row[colWinnings]   : '';
    const lineupRaw   = colLineup >= 0     ? row[colLineup]     : '';
    const contestRaw  = colContest >= 0    ? row[colContest]    : '';
    const dateRaw     = colDate >= 0       ? row[colDate]       : '';
    const contestId   = colContestId >= 0  ? (row[colContestId] || '').trim() : null;
    const entriesRaw  = colEntries >= 0    ? row[colEntries]    : '';

    // Parse place: "42/5000" → finish=42, total=5000; or just "42"
    let finish = null, totalEntries = null;
    if (placeRaw) {
      const m = placeRaw.replace(/[^\d/]/g, '').match(/^(\d+)(?:\/(\d+))?$/);
      if (m) { finish = parseInt(m[1]); if (m[2]) totalEntries = parseInt(m[2]); }
    }
    // Override totalEntries from dedicated column if available
    if (!totalEntries && entriesRaw) {
      const e = parseInt(entriesRaw.replace(/[^0-9]/g, ''));
      if (e > 0) totalEntries = e;
    }

    const actualPts = pointsRaw ? parseFloat(pointsRaw.replace(/[^0-9.]/g, '')) || null : null;
    const winnings  = winRaw    ? parseFloat(winRaw.replace(/[^0-9.]/g, '')) ?? null : null;

    // Infer contest type from name
    let contestType = null;
    if (contestRaw) {
      const cn = contestRaw.toLowerCase();
      if (/thr|gpp|millionaire|giant|large|big|star/.test(cn)) contestType = 'GPP';
      else if (/double|50.50|cash|h2h/.test(cn)) contestType = 'Cash';
      else contestType = 'GPP'; // default assumption
    }

    // Parse slate date from contest start column ("Apr 15, 2026 7:05 PM" → "2026-04-15")
    let slateDate = null;
    if (dateRaw) {
      const d = new Date(dateRaw);
      if (!isNaN(d)) slateDate = d.toISOString().substring(0, 10);
    }

    const players = parseDKLineupStr(lineupRaw);
    if (players.length < 3) continue; // skip empty/unparseable rows

    entries.push({ finish, totalEntries, actualPts, winnings, contestType, slateDate, contestId, contestTitle: contestRaw || null, players });
  }
  return entries;
}

function parseDKLineupStr(lineupStr) {
  if (!lineupStr) return [];
  const DK_POS = new Set(['P','SP','RP','C','1B','2B','3B','SS','OF','DH','FLEX','CPT','UTIL','P/OF','SP/RP']);
  const parts = lineupStr.trim().split(/\s{2,}/).map(p => p.trim()).filter(Boolean);
  return parts.map(part => {
    const tokens = part.split(/\s+/);
    // Remove position token at start or end
    let nameTokens;
    if (tokens.length > 1 && DK_POS.has(tokens[0].toUpperCase())) {
      nameTokens = tokens.slice(1);
    } else if (tokens.length > 1 && DK_POS.has(tokens[tokens.length - 1].toUpperCase())) {
      nameTokens = tokens.slice(0, -1);
    } else {
      nameTokens = tokens;
    }
    return nameTokens.join(' ').replace(/\(\d+\)/g, '').trim();
  }).filter(n => n.length > 2);
}

function normDKName(name) {
  return (name || '').toLowerCase()
    .replace(/\s+(jr\.?|sr\.?|ii|iii|iv)$/i, '')
    .replace(/[^a-z ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function importDKResults(input) {
  const statusEl = document.getElementById('dk-import-status');
  const file = input.files[0];
  if (!file) return;

  statusEl.innerHTML = '<span style="color:var(--tt);font-size:11px">Parsing…</span>';

  const text = await file.text();

  // Auto-detect format by checking for a Lineup column in the header
  const firstLine = text.split('\n')[0].toLowerCase();
  if (!firstLine.includes('lineup')) {
    // My Contests format — route to server-side importer
    try {
      const r = await fetch('/api/contests/import-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: text })
      });
      const result = await r.json();
      if (!r.ok) throw new Error(result.error || r.statusText);
      input.value = '';
      loadHistory();
      const color = result.matched > 0 ? 'var(--tsu)' : 'var(--tw)';
      statusEl.innerHTML = `<div class="ib success" style="color:${color}">`
        + `Detected My Contests format — ${result.rowsParsed} rows parsed, `
        + `<strong>${result.matched}</strong> matched to saved lineups, `
        + `${result.created} new entries created, ${result.skipped} skipped.</div>`;
    } catch (e) {
      statusEl.innerHTML = '<div class="ib warn">Import failed: ' + esc(e.message) + '</div>';
      input.value = '';
    }
    return;
  }

  const parsed = parseDKResultsCSV(text);
  if (!parsed.length) {
    statusEl.innerHTML = '<div class="ib warn">Could not parse CSV — check that this is a DraftKings contest results export with a Lineup column.</div>';
    input.value = '';
    return;
  }

  // Load saved history
  let history;
  try {
    history = await fetch('/api/history').then(r => r.json());
  } catch (e) {
    statusEl.innerHTML = '<div class="ib warn">Failed to load history: ' + esc(e.message) + '</div>';
    input.value = '';
    return;
  }

  if (!history.length) {
    statusEl.innerHTML = '<div class="ib warn">No saved lineups in history to match against. Save lineups in the Backtest tab first.</div>';
    input.value = '';
    return;
  }

  let matched = 0, skipped = 0;
  const updates = [];

  for (const entry of parsed) {
    const dkNorm = entry.players.map(normDKName);
    const dkSet = new Set(dkNorm);

    // Filter candidates by slate date if available
    const candidates = entry.slateDate
      ? history.filter(h => (h.slateDate || h.date?.substring(0, 10)) === entry.slateDate)
      : history;

    // Find best-matching saved lineup (≥7/10 players must match)
    let bestEntry = null, bestScore = 0;
    for (const h of candidates) {
      const savedNames = (h.lineup || []).filter(Boolean).map(p => normDKName(p.name));
      const overlap = savedNames.filter(n => dkSet.has(n)).length;
      if (overlap > bestScore && overlap >= 7) { bestScore = overlap; bestEntry = h; }
    }

    if (!bestEntry) { skipped++; continue; }

    const body = {};
    if (entry.actualPts !== null && !bestEntry.actualPts)          body.actualPts    = entry.actualPts;
    if (entry.winnings  !== null && bestEntry.winnings === null)    body.winnings     = entry.winnings;
    if (entry.finish    !== null && !bestEntry.finish)              body.finish       = entry.finish;
    if (entry.totalEntries !== null && !bestEntry.entries)          body.entries      = entry.totalEntries;
    if (entry.contestId   && !bestEntry.contestId)                  body.contestId    = entry.contestId;
    if (entry.contestTitle && !bestEntry.contestTitle)              body.contestTitle = entry.contestTitle;

    if (Object.keys(body).length === 0) { skipped++; continue; } // already filled

    updates.push(fetch('/api/history/' + bestEntry.id, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }));
    matched++;
  }

  if (updates.length) {
    try {
      await Promise.all(updates);
      loadHistory();
    } catch (e) { /* partial failure — history still reloads */ loadHistory(); }
  }

  const total = parsed.length;
  const color = matched > 0 ? 'var(--tsu)' : 'var(--tw)';
  statusEl.innerHTML = `<div class="ib success" style="color:${color}">`
    + `Imported ${total} entries from CSV — `
    + `<strong>${matched}</strong> matched &amp; updated, `
    + `${skipped} skipped (already filled or no lineup match).`
    + (skipped > matched ? ' Tip: save lineups with a matching slate date before importing.' : '')
    + '</div>';
  input.value = ''; // reset so the same file can be re-imported after fixing issues
}

async function importOwnershipCSV() {
  const statusEl = document.getElementById('own-import-status');
  const date = (document.getElementById('own-import-date')?.value || '').trim();
  const csv = (document.getElementById('own-import-csv')?.value || '').trim();

  if (!date) {
    statusEl.textContent = 'Enter a slate date before importing.';
    return;
  }
  if (!csv) {
    statusEl.textContent = 'Paste ownership CSV data before importing.';
    return;
  }

  statusEl.textContent = 'Importing…';
  try {
    const r = await fetch('/api/ownership/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, csv })
    });
    const body = await r.json();
    if (!r.ok) {
      statusEl.textContent = body.error || 'Import failed.';
      return;
    }
    statusEl.textContent = `Parsed ${body.parsedPlayers} players — ${body.playersMatched} matched, ${body.entriesUpdated} entries updated.`;
    loadHistory();
  } catch (e) {
    statusEl.textContent = 'Import failed: ' + e.message;
  }
}

function toggleOwnershipEntry(id) {
  const row = document.getElementById('own-row-' + id);
  if (row) row.style.display = row.style.display === 'none' ? '' : 'none';
}

async function saveActualOwnership(id) {
  const inputs = document.querySelectorAll(`.own-actual-input[data-hist-id="${id}"]`);
  const actualOwnership = {};
  inputs.forEach(inp => {
    const val = parseFloat(inp.value);
    if (!isNaN(val) && val >= 0) actualOwnership[inp.dataset.player] = val;
  });
  if (!Object.keys(actualOwnership).length) return;
  try {
    await fetch('/api/history/' + id, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actualOwnership })
    });
    showToast(`Ownership saved for ${Object.keys(actualOwnership).length} players`, 'success');
    loadHistory();
  } catch (e) { showToast('Failed to save ownership', 'error'); }
}

function toggleAttribution(id) {
  const row = document.getElementById('attr-row-' + id);
  if (!row) return;
  if (row.style.display === 'none') {
    row.style.display = '';
    renderAttribution(id);
  } else {
    row.style.display = 'none';
  }
}

function renderAttribution(id) {
  const el = document.getElementById('attr-content-' + id);
  const h = STATE.historyData.find(e => e.id === id);
  if (!h || !h.playerActuals || !h.lineup) {
    el.innerHTML = '<span style="color:var(--tw)">No actuals loaded for this entry.</span>';
    return;
  }

  // Classify each player's role: SP, primary stack, secondary stack, bring-back, fill
  const lineup = h.lineup;
  const teamCounts = {};
  lineup.forEach(p => {
    if (!(p.pos || '').includes('P')) teamCounts[p.team] = (teamCounts[p.team] || 0) + 1;
  });
  const stackTeams = Object.entries(teamCounts).filter(([, c]) => c >= 3).sort((a, b) => b[1] - a[1]);
  const primaryStack = stackTeams[0]?.[0] || null;
  const secondaryStack = stackTeams[1]?.[0] || null;
  const stackTeamSet = new Set(stackTeams.map(([t]) => t));

  const roles = { SP: [], 'Primary Stack': [], 'Secondary Stack': [], 'Fill/Pivot': [] };

  lineup.forEach(p => {
    const actual = h.playerActuals[p.name];
    if (actual == null) return;
    const entry = { name: p.name, actual, projected: p.median || 0 };
    if ((p.pos || '').includes('P')) {
      roles['SP'].push(entry);
    } else if (p.team === primaryStack) {
      roles['Primary Stack'].push(entry);
    } else if (p.team === secondaryStack) {
      roles['Secondary Stack'].push(entry);
    } else {
      roles['Fill/Pivot'].push(entry);
    }
  });

  const totalActual = Object.values(roles).flat().reduce((s, e) => s + e.actual, 0);
  if (totalActual <= 0) {
    el.innerHTML = '<span style="color:var(--tw)">Total actual score is 0 — cannot compute attribution.</span>';
    return;
  }

  // Build horizontal bar chart
  const colors = { SP: '#4e79a7', 'Primary Stack': '#59a14f', 'Secondary Stack': '#9c755f', 'Bring-Back': '#edc948', 'Fill/Pivot': '#b07aa1' };
  let barsHtml = '<div style="display:flex;height:22px;border-radius:4px;overflow:hidden;margin-bottom:8px">';
  const segments = [];
  Object.entries(roles).forEach(([role, players]) => {
    const pts = players.reduce((s, e) => s + e.actual, 0);
    if (pts <= 0) return;
    const pct = pts / totalActual * 100;
    segments.push({ role, pts, pct, count: players.length });
    barsHtml += `<div style="width:${pct}%;background:${colors[role]};display:flex;align-items:center;justify-content:center;font-size:9px;color:#fff;font-weight:600;min-width:20px" title="${role}: ${pts.toFixed(1)} pts (${pct.toFixed(1)}%)">${pct >= 8 ? pct.toFixed(0) + '%' : ''}</div>`;
  });
  barsHtml += '</div>';

  // Legend + detail table
  let detailHtml = '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:6px">';
  segments.forEach(s => {
    detailHtml += `<span style="font-size:10px"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${colors[s.role]};margin-right:3px"></span>${s.role}: <strong>${s.pts.toFixed(1)}</strong> pts (${s.pct.toFixed(1)}%)</span>`;
  });
  detailHtml += '</div>';

  // Player-level breakdown
  detailHtml += '<table style="font-size:10px;width:100%"><thead><tr><th>Player</th><th>Role</th><th>Proj</th><th>Actual</th><th>Δ</th></tr></thead><tbody>';
  Object.entries(roles).forEach(([role, players]) => {
    players.forEach(p => {
      const delta = p.actual - p.projected;
      const deltaColor = delta >= 0 ? 'var(--tsu)' : 'var(--td)';
      detailHtml += `<tr><td>${esc(p.name)}</td><td><span style="color:${colors[role]}">${role}</span></td><td>${p.projected.toFixed(1)}</td><td><strong>${p.actual.toFixed(1)}</strong></td><td style="color:${deltaColor}">${delta >= 0 ? '+' : ''}${delta.toFixed(1)}</td></tr>`;
    });
  });
  detailHtml += '</tbody></table>';

  el.innerHTML = `<strong style="color:var(--tp)">Score Attribution</strong> · ${totalActual.toFixed(1)} total pts` + barsHtml + detailHtml;
}

async function deleteHistoryEntry(id) {
  try {
    await fetch('/api/history/' + id, { method: 'DELETE' });
    loadHistory();
  } catch (e) {
    console.error('Delete history failed:', e);
    showToast('Failed to delete history entry: ' + (e.message || e), 'warn', 5000);
  }
}

// ── Phase 1: Fetch & Apply Actual Scores ─────────────────────────────────────

async function fetchAndApplyActuals() {
  const dateInput = document.getElementById('actuals-date');
  const btn = document.getElementById('load-actuals-btn');
  const statusEl = document.getElementById('actuals-status');
  const dateStr = dateInput?.value;
  if (!dateStr) {
    statusEl.innerHTML = '<div class="ib warn">Select a date first.</div>';
    return;
  }
  btn.textContent = 'Loading...'; btn.disabled = true;
  statusEl.innerHTML = '';
  try {
    const res = await fetch('/api/actuals/apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: dateStr })
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Failed');
    // Surface per-game failures — previously these were silently dropped and the user
    // believed all games loaded. Reported counts now reflect the actual fetch outcome.
    const failedNote = (data.failedGames && data.failedGames.length)
      ? ` <span class="warn">⚠ ${data.failedGames.length} of ${data.gameCount} games failed to load (gamePks: ${data.failedGames.slice(0, 3).map(f => f.gamePk).join(', ')}${data.failedGames.length > 3 ? '…' : ''}). Retry in a few minutes if games are still in progress.</span>`
      : '';
    if (failedNote) {
      showToast(`${data.failedGames.length} of ${data.gameCount} games failed to load actuals. Some players may show 0 pts.`, 'warn', 7000);
    }
    if (data.updated > 0) {
      statusEl.innerHTML = `<div class="ib success">${data.updated} lineup(s) updated — ${data.playerCount} players matched for ${dateStr} (${data.loadedGameCount ?? data.gameCount}/${data.gameCount} games).${failedNote}</div>`;

      // Refresh source quality using per-source snapshots saved at lineup creation time
      const history = await fetch('/api/history').then(r => r.json());
      const sourcesForDate = [];
      const seen = new Set();
      history.forEach(entry => {
        const eDate = entry.slateDate || entry.date?.substring(0, 10);
        if (eDate !== dateStr || !Array.isArray(entry.sources)) return;
        entry.sources.forEach(s => {
          if (s.name && !seen.has(s.name)) {
            seen.add(s.name);
            sourcesForDate.push({ name: s.name, projections: s.projections });
          }
        });
      });
      if (sourcesForDate.length) {
        fetch('/api/source-quality/update', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date: dateStr, sources: sourcesForDate })
        }).then(() => renderSourceQuality()).catch(() => {});
      }
    } else {
      statusEl.innerHTML = `<div class="ib warn">${esc(data.message || 'No matching lineups found for ' + dateStr + '. Make sure lineups were saved with this slate date.')}</div>`;
    }
    loadHistory();
  } catch (e) {
    statusEl.innerHTML = `<div class="ib warn">Error: ${esc(e.message)}</div>`;
  } finally {
    btn.textContent = 'Load Actuals'; btn.disabled = false;
  }
}

// ── Phase 3: Model Analysis & Calibration ────────────────────────────────────

async function loadModelAnalysis() {
  const el = document.getElementById('model-analysis');
  el.innerHTML = '<div style="color:var(--tt);font-size:12px;padding:8px 0">Analyzing projection accuracy...</div>';
  try {
    const data = await fetch('/api/history/analysis').then(r => r.json());
    renderModelAnalysis(data);
  } catch (e) {
    el.innerHTML = `<div class="ib warn">Analysis failed: ${esc(e.message)}</div>`;
  }
}

function renderModelAnalysis(data) {
  // Stash for button handlers — avoids JSON.stringify inside onclick attributes
  STATE._lastAnalysis = data;
  const el = document.getElementById('model-analysis');
  if (!data.sufficient) {
    const sections = [];
    sections.push(`<div class="ib blue" style="font-size:12px;margin-bottom:10px">${esc(data.message || 'Not enough data yet.')}</div>`);
    if (data.lineupAnalysis) sections.push(renderLineupAnalysis(data.lineupAnalysis));
    if (data.contestPerf)    sections.push(renderContestPerf(data.contestPerf));
    el.innerHTML = sections.join('');
    return;
  }

  const o = data.overall, p = data.pitchers, b = data.batters;
  const confColor = { high: 'var(--tsu)', medium: 'var(--ti)', low: 'var(--tw)', insufficient: 'var(--td)' }[data.suggestion.confidence] || 'var(--ts)';
  const biasLabel = (val) => {
    if (!val && val !== 0) return '—';
    const pct = (val * 100).toFixed(1);
    const sign = val > 0 ? '+' : '';
    const color = Math.abs(val) < 0.05 ? 'var(--tsu)' : 'var(--tw)';
    const note = val > 0.02 ? ' (under-projected)' : val < -0.02 ? ' (over-projected)' : ' (well-calibrated)';
    return `<span style="color:${color};font-weight:500">${sign}${pct}%${note}</span>`;
  };

  el.innerHTML = `
    <div class="mc-row">
      <div class="mc"><div class="mc-l">Players Analyzed</div><div class="mc-v">${data.sampleSize}</div><div class="mc-s">actual scores matched</div></div>
      <div class="mc"><div class="mc-l">Rank Correlation</div><div class="mc-v" style="color:${o?.spearman > 0.5 ? 'var(--tsu)' : o?.spearman > 0.3 ? 'var(--ti)' : 'var(--td)'}">${o?.spearman?.toFixed(3) ?? '—'}</div><div class="mc-s">Spearman ρ (higher=better)</div></div>
      <div class="mc"><div class="mc-l">Overall RMSE</div><div class="mc-v">${o?.rmse ? (o.rmse * 100).toFixed(1) + '%' : '—'}</div><div class="mc-s">relative error</div></div>
      <div class="mc"><div class="mc-l">Confidence</div><div class="mc-v" style="color:${confColor};font-size:14px;text-transform:capitalize">${data.suggestion.confidence}</div><div class="mc-s">${data.sampleSize >= 100 ? '100+ samples' : data.sampleSize + ' samples'}</div></div>
    </div>

    <div class="sec-label" style="margin-top:4px">Bias by Position</div>
    <div style="background:var(--bs);border-radius:var(--r);padding:12px;margin-bottom:10px">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px;margin-bottom:8px">
        <div><strong>Pitchers</strong> (${p?.count ?? 0} samples)<br>${biasLabel(p?.bias)}</div>
        <div><strong>Batters</strong> (${b?.count ?? 0} samples)<br>${biasLabel(b?.bias)}</div>
        ${data.topOrder?.count ? `<div><strong>Top of Order (1-3)</strong> (${data.topOrder.count})<br>${biasLabel(data.topOrder.bias)}</div>` : ''}
        ${data.highOwnership?.count ? `<div><strong>High Ownership (>25%)</strong> (${data.highOwnership.count})<br>${biasLabel(data.highOwnership.bias)}</div>` : ''}
      </div>
      ${data.byPosition && Object.keys(data.byPosition).length > 0 ? `
      <div style="border-top:0.5px solid var(--brd-s);padding-top:8px;margin-top:4px">
        <div style="font-size:10px;text-transform:uppercase;color:var(--tt);margin-bottom:6px;letter-spacing:0.05em">Per-Position Bias & Suggested Scale</div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;font-size:11px">
          ${Object.entries(data.byPosition).map(([pos, s]) => {
            const bColor = Math.abs(s.bias) < 0.05 ? 'var(--tsu)' : Math.abs(s.bias) < 0.15 ? 'var(--tw)' : 'var(--td)';
            const biasSign = s.bias > 0 ? '+' : '';
            const lowSample = s.count < 10;
            return `<div style="background:var(--bp);border-radius:4px;padding:5px 7px;${lowSample ? 'opacity:0.75' : ''}">
              <div style="font-weight:600;color:var(--tp)">${esc(pos)} <span style="font-weight:400;color:var(--tt)">(${s.count}${lowSample ? ' ⚠' : ''})</span></div>
              <div style="color:${bColor}">${biasSign}${(s.bias*100).toFixed(1)}%</div>
              <div style="color:var(--tt)">scale: <strong>${s.calibrationFactor?.toFixed(3)}</strong></div>
              ${lowSample ? `<div style="font-size:9px;color:var(--tw)">low sample</div>` : ''}
            </div>`;
          }).join('')}
        </div>
      </div>` : ''}
    </div>

    <div class="sec-label">Calibration Factors</div>
    <div style="background:var(--bs);border-radius:var(--r);padding:12px;margin-bottom:10px;font-size:12px">
      <div style="margin-bottom:6px">Pitcher projections × <strong>${data.suggestion.pitcherCalibration?.toFixed(3)}</strong>
        ${Math.abs((data.suggestion.pitcherCalibration ?? 1) - 1) < 0.015 ? ' — already accurate' : data.suggestion.pitcherCalibration < 1 ? ' — will reduce over-inflated pitcher projections' : ' — will increase under-estimated pitcher projections'}</div>
      <div>Batter projections × <strong>${data.suggestion.batterCalibration?.toFixed(3)}</strong>
        ${Math.abs((data.suggestion.batterCalibration ?? 1) - 1) < 0.015 ? ' — already accurate' : data.suggestion.batterCalibration < 1 ? ' — will reduce over-inflated batter projections' : ' — will increase under-estimated batter projections'}</div>
    </div>

    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      ${data.byPosition && Object.keys(data.byPosition).length >= 4
        ? `<button class="btn-g" onclick="applyPositionScalesFromLastAnalysis()">Apply Position Scales</button>`
        : `<button class="btn-g" onclick="applyBlanketScalesFromLastAnalysis()">Apply Calibration</button>`}
      <button class="btn" onclick="applyBlanketScalesFromLastAnalysis()">Apply Blanket Scales</button>
      <button class="btn" onclick="resetCalibration()">Reset to Default</button>
      <span id="cal-status" style="font-size:11px;color:var(--ts)"></span>
    </div>

    ${data.simCalibration ? `
    <div class="sec-label" style="margin-top:12px">Simulation Tail Calibration</div>
    <div style="background:var(--bs);border-radius:var(--r);padding:12px;margin-bottom:10px;font-size:12px">
      <div style="margin-bottom:4px;color:var(--tt)">${data.simCalibration.sampleSize} player outcomes analyzed</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:8px">
        <div>
          <div style="color:var(--tt);font-size:10px;text-transform:uppercase">Actual > P90</div>
          <div style="font-size:16px;font-weight:600;color:${Math.abs(data.simCalibration.actualP90ExceedRate - 10) < 5 ? 'var(--tsu)' : 'var(--tw)'}">${data.simCalibration.actualP90ExceedRate}%</div>
          <div style="font-size:10px;color:var(--tt)">expected ~10%</div>
        </div>
        <div>
          <div style="color:var(--tt);font-size:10px;text-transform:uppercase">Actual > P75</div>
          <div style="font-size:16px;font-weight:600;color:${Math.abs(data.simCalibration.actualP75ExceedRate - 25) < 8 ? 'var(--tsu)' : 'var(--tw)'}">${data.simCalibration.actualP75ExceedRate}%</div>
          <div style="font-size:10px;color:var(--tt)">expected ~25%</div>
        </div>
        <div>
          <div style="color:var(--tt);font-size:10px;text-transform:uppercase">Actual < P10</div>
          <div style="font-size:16px;font-weight:600;color:${Math.abs(data.simCalibration.actualBelowP10Rate - 10) < 5 ? 'var(--tsu)' : 'var(--tw)'}">${data.simCalibration.actualBelowP10Rate}%</div>
          <div style="font-size:10px;color:var(--tt)">expected ~10%</div>
        </div>
      </div>
      <div style="font-size:11px;color:${data.simCalibration.tailDiagnosis === 'well_calibrated' ? 'var(--tsu)' : 'var(--tw)'}">
        ${data.simCalibration.tailDiagnosis === 'well_calibrated' ? '✓ Distributions are well-calibrated — tail probabilities match observed rates.'
        : data.simCalibration.tailDiagnosis === 'tails_too_fat' ? '⚠ Distributions have tails that are too fat — ceiling projections are overconfident. Consider reducing Score Diversity slider or tightening ceiling estimates.'
        : '⚠ Distributions have tails that are too tight — ceiling projections are underconfident. Consider increasing Score Diversity slider.'}
      </div>
    </div>
    ` : ''}

    ${data.ownershipCalibration ? `
    <div class="sec-label" style="margin-top:12px">Ownership Projection Calibration</div>
    <div style="background:var(--bs);border-radius:var(--r);padding:12px;margin-bottom:10px;font-size:12px">
      <div style="margin-bottom:4px;color:var(--tt)">${data.ownershipCalibration.sampleSize} player-ownership pairs across ${data.ownershipCalibration.slates} slate${data.ownershipCalibration.slates !== 1 ? 's' : ''}</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:8px">
        <div>
          <div style="color:var(--tt);font-size:10px;text-transform:uppercase">MAE</div>
          <div style="font-size:16px;font-weight:600;color:${data.ownershipCalibration.mae < 5 ? 'var(--tsu)' : 'var(--tw)'}">${data.ownershipCalibration.mae}%</div>
          <div style="font-size:10px;color:var(--tt)">avg absolute error</div>
        </div>
        <div>
          <div style="color:var(--tt);font-size:10px;text-transform:uppercase">Correlation</div>
          <div style="font-size:16px;font-weight:600;color:${data.ownershipCalibration.correlation > 0.7 ? 'var(--tsu)' : data.ownershipCalibration.correlation > 0.4 ? 'var(--ti)' : 'var(--td)'}">${data.ownershipCalibration.correlation.toFixed(3)}</div>
          <div style="font-size:10px;color:var(--tt)">projected vs actual</div>
        </div>
        <div>
          <div style="color:var(--tt);font-size:10px;text-transform:uppercase">Avg Bias</div>
          <div style="font-size:16px;font-weight:600;color:${Math.abs(data.ownershipCalibration.avgError) < 2 ? 'var(--tsu)' : 'var(--tw)'}">${data.ownershipCalibration.avgError > 0 ? '+' : ''}${data.ownershipCalibration.avgError}%</div>
          <div style="font-size:10px;color:var(--tt)">${data.ownershipCalibration.avgError > 0 ? 'under-projecting' : data.ownershipCalibration.avgError < 0 ? 'over-projecting' : 'neutral'}</div>
        </div>
      </div>
      ${data.ownershipCalibration.lowOwn || data.ownershipCalibration.midOwn || data.ownershipCalibration.highOwn ? `
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:6px">
        ${data.ownershipCalibration.lowOwn ? `<div style="font-size:10px"><span style="color:var(--tt)">Low Own (<10%)</span><br>bias: <strong>${data.ownershipCalibration.lowOwn.avgError > 0 ? '+' : ''}${data.ownershipCalibration.lowOwn.avgError}%</strong> (${data.ownershipCalibration.lowOwn.count})</div>` : '<div></div>'}
        ${data.ownershipCalibration.midOwn ? `<div style="font-size:10px"><span style="color:var(--tt)">Mid Own (10-25%)</span><br>bias: <strong>${data.ownershipCalibration.midOwn.avgError > 0 ? '+' : ''}${data.ownershipCalibration.midOwn.avgError}%</strong> (${data.ownershipCalibration.midOwn.count})</div>` : '<div></div>'}
        ${data.ownershipCalibration.highOwn ? `<div style="font-size:10px"><span style="color:var(--tt)">High Own (>25%)</span><br>bias: <strong>${data.ownershipCalibration.highOwn.avgError > 0 ? '+' : ''}${data.ownershipCalibration.highOwn.avgError}%</strong> (${data.ownershipCalibration.highOwn.count})</div>` : '<div></div>'}
      </div>` : ''}
      <div style="font-size:11px;color:${data.ownershipCalibration.diagnosis === 'well_calibrated' ? 'var(--tsu)' : 'var(--tw)'}">
        ${data.ownershipCalibration.diagnosis === 'well_calibrated' ? '✓ Ownership projections are well-calibrated.'
        : data.ownershipCalibration.diagnosis === 'under_projecting_ownership' ? '⚠ Under-projecting ownership — actual own% is higher than projected. Your "contrarian" plays may not be as contrarian as you think.'
        : '⚠ Over-projecting ownership — actual own% is lower than projected. You may be over-fading popular plays.'}
      </div>
    </div>
    ` : ''}

    <div id="active-calibration" style="margin-top:8px;font-size:11px;color:var(--tt)"></div>

    ${data.lineupAnalysis ? renderLineupAnalysis(data.lineupAnalysis) : ''}
    ${data.contestPerf    ? renderContestPerf(data.contestPerf)       : ''}
  `;
  renderActiveCalibration();
}

function renderLineupAnalysis(la) {
  const biasSign  = la.bias > 0 ? '+' : '';
  const biasColor = Math.abs(la.bias) < 0.05 ? 'var(--tsu)' : Math.abs(la.bias) < 0.15 ? 'var(--tw)' : 'var(--td)';
  const rhoColor  = la.spearman > 0.5 ? 'var(--tsu)' : la.spearman > 0.3 ? 'var(--ti)' : 'var(--td)';
  return `
    <div class="sec-label" style="margin-top:10px">Lineup-Level Projection Accuracy</div>
    <div style="background:var(--bs);border-radius:var(--r);padding:12px;margin-bottom:10px;font-size:12px">
      <div style="color:var(--tt);margin-bottom:8px;font-size:11px">${la.count} saved lineups with both projected and actual totals</div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px">
        <div><div style="color:var(--tt);font-size:10px;text-transform:uppercase">Avg Projected</div><div style="font-size:16px;font-weight:600">${la.avgProjected}</div><div style="font-size:10px;color:var(--tt)">pts</div></div>
        <div><div style="color:var(--tt);font-size:10px;text-transform:uppercase">Avg Actual</div><div style="font-size:16px;font-weight:600">${la.avgActual}</div><div style="font-size:10px;color:var(--tt)">pts</div></div>
        <div><div style="color:var(--tt);font-size:10px;text-transform:uppercase">Overall Bias</div><div style="font-size:16px;font-weight:600;color:${biasColor}">${biasSign}${(la.bias*100).toFixed(1)}%</div><div style="font-size:10px;color:var(--tt)">${la.bias > 0.02 ? 'under-projected' : la.bias < -0.02 ? 'over-projected' : 'well-calibrated'}</div></div>
        <div><div style="color:var(--tt);font-size:10px;text-transform:uppercase">Rank Corr.</div><div style="font-size:16px;font-weight:600;color:${rhoColor}">${la.spearman.toFixed(3)}</div><div style="font-size:10px;color:var(--tt)">Spearman ρ</div></div>
      </div>
      <div style="margin-top:8px;font-size:11px;color:var(--tt)">Uniform calibration factor: <strong style="color:var(--tp)">${la.calibrationFactor.toFixed(3)}</strong> — applies equally to pitchers and batters. Load actuals for per-player breakdown.</div>
    </div>`;
}

function renderContestPerf(cp) {
  const roiColor = cp.roi == null ? 'var(--ts)' : cp.roi >= 0 ? 'var(--tsu)' : 'var(--td)';
  const cashColor = cp.cashRate >= 50 ? 'var(--tsu)' : cp.cashRate >= 35 ? 'var(--tw)' : 'var(--td)';
  return `
    <div class="sec-label" style="margin-top:10px">Contest Performance (${cp.count} entries)</div>
    <div style="background:var(--bs);border-radius:var(--r);padding:12px;margin-bottom:10px;font-size:12px">
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:8px">
        <div><div style="color:var(--tt);font-size:10px;text-transform:uppercase">Cash Rate</div><div style="font-size:16px;font-weight:600;color:${cashColor}">${cp.cashRate}%</div><div style="font-size:10px;color:var(--tt)">entries in the money</div></div>
        <div><div style="color:var(--tt);font-size:10px;text-transform:uppercase">Top 10%</div><div style="font-size:16px;font-weight:600">${cp.top10Rate}%</div><div style="font-size:10px;color:var(--tt)">of entries</div></div>
        <div><div style="color:var(--tt);font-size:10px;text-transform:uppercase">Avg Finish</div><div style="font-size:16px;font-weight:600">${cp.avgFinishPct}%</div><div style="font-size:10px;color:var(--tt)">of field</div></div>
        <div><div style="color:var(--tt);font-size:10px;text-transform:uppercase">Avg Score</div><div style="font-size:16px;font-weight:600">${cp.avgScore}</div><div style="font-size:10px;color:var(--tt)">DK pts</div></div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:8px">
        <div><div style="color:var(--tt);font-size:10px;text-transform:uppercase">Score P25/P50/P75</div><div style="font-size:13px;font-weight:600">${cp.scoreP25} / ${cp.scoreP50} / ${cp.scoreP75}</div></div>
        <div><div style="color:var(--tt);font-size:10px;text-transform:uppercase">Total Winnings</div><div style="font-size:13px;font-weight:600;color:var(--tsu)">$${cp.totalWinnings.toFixed(2)}</div></div>
        ${cp.roi != null ? `<div><div style="color:var(--tt);font-size:10px;text-transform:uppercase">ROI</div><div style="font-size:13px;font-weight:600;color:${roiColor}">${cp.roi >= 0 ? '+' : ''}${cp.roi}%</div></div>` : '<div></div>'}
      </div>
    </div>`;
}

function runContestFlashback() {
  const el = document.getElementById('flashback-results');
  const filter = document.getElementById('flashback-contest-filter')?.value || 'ALL';
  if (!el) return;

  const eligible = STATE.historyData.filter(h => {
    if (!h.playerActuals || Object.keys(h.playerActuals).length < 5) return false;
    if (!h.lineup || !h.lineup.length) return false;
    if (filter !== 'ALL' && h.contest?.toUpperCase() !== filter.toUpperCase()) return false;
    return true;
  });

  if (eligible.length < 3) {
    el.innerHTML = '<div class="ib warn">Need at least 3 saved lineups with player actuals loaded. Use "Load Actuals" above to populate scores.</div>';
    return;
  }

  el.innerHTML = '<div style="font-size:12px;color:var(--tt);padding:8px 0">Simulating…</div>';

  setTimeout(async () => {
    // Build a pool from each entry's lineup + playerActuals for field simulation.
    // Process entries sequentially (await each) so simulatePortfolio can yield
    // between sims and keep the UI thread responsive.
    const flashResults = [];
    for (const h of eligible) {
      // Reconstruct a pool-like array from the lineup snapshot with actual scores as "median"
      const pool = (h.lineup || []).map(p => ({
        ...p, median: h.playerActuals?.[p.name] ?? p.median ?? 0,
        floor: p.floor || 0, ceiling: p.ceiling || (p.median * 1.8) || 0,
        own: p.own || 0, salary: p.salary || 3000,
        rosterPos: p.pos || p.rosterPos || 'OF'
      })).filter(p => p.median > 0);
      if (pool.length < 5) continue;

      // Build a lightweight "lineup array" aligned to DK_SLOTS
      const fullLineup = pool.slice(0, 10);
      while (fullLineup.length < 10) fullLineup.push(fullLineup[0]);

      const isCash = (h.contest || '').toUpperCase() === 'CASH';
      const contestType = isCash ? 'cash' : 'gpp';

      // Run 2000 sim portfolio (single lineup) — 500 had ±2.2% SE on cash rate, unreliable for ranking
      const simResults = await Engine.simulatePortfolio([fullLineup], pool, 2000, contestType);
      if (!simResults.length) continue;
      const sr = simResults[0];

      flashResults.push({
        date: h.slateDate || new Date(h.date).toLocaleDateString(),
        contest: h.contest || 'GPP',
        buyin: h.buyin || 0,
        actualPts: h.actualPts || null,
        projPts: h.projectedPts || 0,
        p50: sr.p50,
        cashRate: sr.cashRate,
        winRate: sr.winRate,
        simROI: sr.simROI,
        actualROI: h.buyin && h.winnings != null ? parseFloat(((h.winnings - h.buyin) / h.buyin * 100).toFixed(1)) : null
      });
    }

    if (!flashResults.length) {
      el.innerHTML = '<div class="ib warn">Could not simulate — ensure lineups have valid player data.</div>';
      return;
    }

    const avgSimROI = flashResults.reduce((s, r) => s + r.simROI, 0) / flashResults.length;
    const avgCashRate = flashResults.reduce((s, r) => s + r.cashRate, 0) / flashResults.length;
    const withActualROI = flashResults.filter(r => r.actualROI != null);
    const avgActualROI = withActualROI.length
      ? withActualROI.reduce((s, r) => s + r.actualROI, 0) / withActualROI.length
      : null;

    let html = `<div class="mc-row">
      <div class="mc"><div class="mc-l">Slates Analyzed</div><div class="mc-v">${flashResults.length}</div></div>
      <div class="mc"><div class="mc-l">Avg P(Thresh)</div><div class="mc-v" style="color:${avgSimROI >= 0 ? 'var(--tsu)' : 'var(--td)'}">
        ${avgSimROI >= 0 ? '+' : ''}${avgSimROI.toFixed(1)}%</div><div class="mc-s">vs. ownership field</div></div>
      <div class="mc"><div class="mc-l">Avg Cash Rate</div><div class="mc-v">${avgCashRate.toFixed(1)}%</div></div>
      ${avgActualROI != null ? `<div class="mc"><div class="mc-l">Actual ROI</div><div class="mc-v" style="color:${avgActualROI >= 0 ? 'var(--tsu)' : 'var(--td)'}">
        ${avgActualROI >= 0 ? '+' : ''}${avgActualROI.toFixed(1)}%</div><div class="mc-s">${withActualROI.length} entries w/ results</div></div>` : ''}
    </div>`;

    html += `<div style="overflow-x:auto;margin-top:8px"><table style="font-size:11px;width:100%">
      <thead><tr>
        <th style="text-align:left">Date</th><th>Contest</th><th>P50</th>
        <th>Cash%</th><th>P(Thresh)</th>
        ${withActualROI.length ? '<th>Actual ROI</th>' : ''}
        <th>Proj</th><th>Actual</th>
      </tr></thead><tbody>`;

    flashResults.sort((a, b) => b.simROI - a.simROI).forEach(r => {
      const roiColor = r.simROI >= 10 ? 'var(--tsu)' : r.simROI >= 0 ? 'var(--ti)' : 'var(--td)';
      const aRoiColor = r.actualROI != null ? (r.actualROI >= 0 ? 'var(--tsu)' : 'var(--td)') : '';
      html += `<tr>
        <td>${esc(r.date)}</td>
        <td><span class="pill pg" style="font-size:9px">${esc(r.contest)}</span></td>
        <td>${r.p50.toFixed(1)}</td>
        <td>${r.cashRate}%</td>
        <td style="font-weight:600;color:${roiColor}">${r.simROI >= 0 ? '+' : ''}${r.simROI}%</td>
        ${withActualROI.length ? `<td style="color:${aRoiColor}">${r.actualROI != null ? (r.actualROI >= 0 ? '+' : '') + r.actualROI + '%' : '—'}</td>` : ''}
        <td style="color:var(--ts)">${r.projPts.toFixed(1)}</td>
        <td>${r.actualPts != null ? r.actualPts.toFixed(1) : '—'}</td>
      </tr>`;
    });
    html += '</tbody></table></div>';
    el.innerHTML = html;
  }, 30);
}

// Called by "Apply Position Scales" button — reads stashed analysis data so we
// never embed JSON.stringify output inside an onclick HTML attribute.
// Also passes the blanket pitcher/batter scales as fallback for any positions
// that had fewer than 5 samples and are therefore absent from positionScales.
// Returns true if the user has confirmed they want to apply low-confidence calibration.
// Hard-blocks below 20 total actuals (suggestion is pure noise at that sample size).
// Soft-prompts at 20-40 total actuals (medium confidence — usable but not yet reliable).
// Returns true (no prompt) at 40+ actuals.
function confirmCalibrationConfidence(data) {
  const totalCount = data.totalCount || data.count || (data.pairs?.length ?? 0)
    || Object.values(data.byPosition || {}).reduce((s, x) => s + (x.count || 0), 0);
  if (totalCount >= 40) return true;
  if (totalCount < 20) {
    alert(
      `Calibration is based on ${totalCount} player actuals — well below the minimum reliable sample size of 40.\n\n` +
      `At this sample size, the suggested scales are dominated by noise rather than systematic bias. ` +
      `Applying them now will likely degrade projection accuracy.\n\n` +
      `Load actuals for more slates first, then re-run Analyze Projections.`
    );
    return false;
  }
  return confirm(
    `Calibration is based on ${totalCount} player actuals (medium confidence).\n\n` +
    `At this sample size, the suggested scales may still be noisy. The Bayesian shrinkage will reduce their magnitude, ` +
    `but applying them may still affect projection accuracy in unexpected ways.\n\n` +
    `Continue applying calibration?`
  );
}

function applyPositionScalesFromLastAnalysis() {
  const data = STATE._lastAnalysis;
  if (!data?.suggestion?.positionScales) return;

  if (!confirmCalibrationConfidence(data)) return;

  // Bayesian shrinkage: blend the raw calibration factor toward 1.0 (neutral prior)
  // based on sample size. This replaces the hard 0.70 floor in applyCalibration,
  // which prevented the model from expressing well-supported large adjustments
  // (3B and OF were hitting the floor on every slate due to systematic over-projection).
  //
  // Trust schedule: n=10 → 25% confidence; n=20 → 50%; n=40+ → 100%.
  // At 40+ observations the correction is fully applied with no shrinkage.
  const shrunkScales = {};
  const rawScales = data.suggestion.positionScales;
  Object.entries(rawScales).forEach(([pos, factor]) => {
    const count = data.byPosition?.[pos]?.count || 0;
    const trust = Math.min(1.0, count / 40);
    shrunkScales[pos] = parseFloat((1.0 * (1 - trust) + factor * trust).toFixed(4));
  });

  // Show before/after preview, then apply if user confirms (#12 calibration impact preview)
  if (!previewCalibrationImpact(data.suggestion.pitcherCalibration ?? 1.0, data.suggestion.batterCalibration ?? 1.0, shrunkScales)) {
    return;
  }

  applyCalibration(
    data.suggestion.pitcherCalibration ?? 1.0,
    data.suggestion.batterCalibration ?? 1.0,
    shrunkScales
  );
}

function applyBlanketScalesFromLastAnalysis() {
  const data = STATE._lastAnalysis;
  if (!data?.suggestion) return;
  if (!confirmCalibrationConfidence(data)) return;
  if (!previewCalibrationImpact(data.suggestion.pitcherCalibration ?? 1.0, data.suggestion.batterCalibration ?? 1.0, {})) return;
  applyCalibration(data.suggestion.pitcherCalibration ?? 1.0, data.suggestion.batterCalibration ?? 1.0);
}

// #12: Show before/after projection table for the top 20 players given proposed calibration.
// Returns true if user confirms application, false otherwise.
function previewCalibrationImpact(pitcherScale, batterScale, positionScales) {
  if (!STATE.POOL || !STATE.POOL.length) return true; // no pool to preview against — let it through
  // Find top 20 by median across batters + top 5 pitchers
  const batters = STATE.POOL.filter(p => !Engine.rp(p, 'P') && p.median > 0)
    .sort((a, b) => b.median - a.median).slice(0, 15);
  const pitchers = STATE.POOL.filter(p => Engine.rp(p, 'P') && p.median > 0)
    .sort((a, b) => b.median - a.median).slice(0, 5);
  const sample = [...pitchers, ...batters];

  const rows = sample.map(p => {
    const isP = Engine.rp(p, 'P');
    const rawPos = (p.dkPos || p.rosterPos || '').split('/')[0].trim();
    const posScale = isP ? (positionScales['P'] ?? positionScales['SP'] ?? 1.0) : (positionScales[rawPos] ?? 1.0);
    const blanketScale = isP ? pitcherScale : batterScale;
    const totalScale = blanketScale * posScale;
    const before = p.median;
    const after = before * totalScale;
    const delta = ((after - before) / before * 100);
    return { name: p.name, pos: isP ? 'P' : rawPos, before, after, delta };
  });

  // Build a simple summary
  const maxDelta = Math.max(...rows.map(r => Math.abs(r.delta)));
  const summary = rows.map(r =>
    `${r.name.padEnd(24)} ${r.pos.padEnd(3)}  ${r.before.toFixed(1).padStart(5)} → ${r.after.toFixed(1).padStart(5)}  (${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(1)}%)`
  ).join('\n');

  const msg =
    `Calibration preview — top 20 players will change as follows:\n` +
    `(P×${pitcherScale.toFixed(3)}, B×${batterScale.toFixed(3)}` +
    (Object.keys(positionScales).length ? `, position scales: ${Object.entries(positionScales).map(([k, v]) => `${k}×${v.toFixed(2)}`).join(', ')}` : '') +
    `)\n\n` +
    `Largest change: ±${maxDelta.toFixed(1)}%\n\n` +
    summary + '\n\n' +
    `Apply this calibration?`;

  return confirm(msg);
}

async function applyCalibration(pitcherScale, batterScale, positionScales = {}) {
  // ── Guard rail: clamp blanket scales to ±20% ─────────────────────────────
  // Scales outside this range indicate either a sampling error (too few slates)
  // or a data quality issue (broken projection source). Allow up to ±20% and
  // warn loudly if the raw suggestion was more extreme.
  const CAL_MIN = 0.80, CAL_MAX = 1.20;
  const clampedBat = Math.max(CAL_MIN, Math.min(CAL_MAX, parseFloat(batterScale) || 1.0));
  const clampedPit = Math.max(CAL_MIN, Math.min(CAL_MAX, parseFloat(pitcherScale) || 1.0));

  const batClamped = Math.abs(clampedBat - batterScale) > 0.001;
  const pitClamped = Math.abs(clampedPit - pitcherScale) > 0.001;

  if (batClamped || pitClamped) {
    const msgs = [];
    if (batClamped) msgs.push(`batter ${(+batterScale).toFixed(3)} → ${clampedBat.toFixed(3)}`);
    if (pitClamped) msgs.push(`pitcher ${(+pitcherScale).toFixed(3)} → ${clampedPit.toFixed(3)}`);
    showToast(
      `Calibration clamped to ±20% model limit (${msgs.join(', ')}). ` +
      `Scale suggestions >20% likely reflect a data quality issue — re-run after more slates.`,
      'warn', 8000
    );
  }

  // Clamp per-position scales to ±40%. The Bayesian shrinkage in
  // applyPositionScalesFromLastAnalysis already protects against low-sample extremes,
  // so the hard floor here is only a last-resort safety rail, not the primary guard.
  const clampedPositionScales = {};
  Object.entries(positionScales || {}).forEach(([pos, s]) => {
    clampedPositionScales[pos] = Math.max(0.60, Math.min(1.40, parseFloat(s) || 1.0));
  });

  try {
    await fetch('/api/calibration', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pitcherScale: clampedPit, batterScale: clampedBat, positionScales: clampedPositionScales })
    });
    Engine.setCalibration({ pitcherScale: clampedPit, batterScale: clampedBat, positionScales: clampedPositionScales });
    const st = document.getElementById('cal-status');
    if (st) {
      const posCount = Object.keys(clampedPositionScales).length;
      const parts = [];
      if (posCount > 0) parts.push(`${posCount} position scales`);
      if (Math.abs(clampedPit - 1) > 0.001) parts.push(`P×${clampedPit.toFixed(3)}`);
      if (Math.abs(clampedBat - 1) > 0.001) parts.push(`B×${clampedBat.toFixed(3)}`);
      st.textContent = parts.length
        ? `Applied: ${parts.join(', ')} — optimizer will use adjusted projections.`
        : 'Calibration applied (no change from default).';
      st.style.color = 'var(--tsu)';
    }
    renderActiveCalibration();
  } catch (e) {
    // CRITICAL: silent failure meant the calibration scales weren't persisted to disk —
    // they'd apply in-memory until reload then revert to whatever was on disk, causing
    // mysterious projection accuracy regressions on the next slate.
    console.error('Apply calibration failed:', e);
    showToast('Failed to save calibration to server: ' + (e.message || e) + '. Scales will reset on reload — retry Apply.', 'warn', 8000);
  }
}

async function resetCalibration() {
  try {
    await fetch('/api/calibration', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pitcherScale: 1.0, batterScale: 1.0, positionScales: {} })
    });
    Engine.setCalibration({ pitcherScale: 1.0, batterScale: 1.0, positionScales: {} });
    const st = document.getElementById('cal-status');
    if (st) { st.textContent = 'Calibration reset to default (no adjustment).'; st.style.color = 'var(--ts)'; }
    renderActiveCalibration();
  } catch (e) {
    console.error('Reset calibration failed:', e);
    showToast('Failed to reset calibration: ' + (e.message || e), 'warn', 5000);
  }
}

function renderActiveCalibration() {
  const cal = Engine.getCalibration();
  const el = document.getElementById('active-calibration');
  if (!el) return;
  const posScales = cal.positionScales || {};
  const hasPosCales = Object.keys(posScales).length > 0;
  const hasBlankScales = cal.pitcherScale !== 1.0 || cal.batterScale !== 1.0;
  if (!hasPosCales && !hasBlankScales) {
    el.textContent = 'No calibration active — using raw projections.';
    el.style.color = 'var(--tt)';
  } else if (hasPosCales) {
    const parts = Object.entries(posScales).map(([pos, s]) => `${pos}×${s.toFixed(2)}`).join(', ');
    el.textContent = `Active calibration (position-specific): ${parts}`;
    el.style.color = 'var(--ti)';
  } else {
    el.textContent = `Active calibration: pitchers ×${cal.pitcherScale?.toFixed(3)}, batters ×${cal.batterScale?.toFixed(3)}`;
    el.style.color = 'var(--ti)';
  }
}

// ── Confirmed Lineups ─────────────────────────────────────────────────────────
async function loadConfirmedLineups() {
  const btn = document.getElementById('fetch-lineups-btn');
  const el = document.getElementById('lineups-status');
  if (btn) { btn.textContent = 'Loading...'; btn.disabled = true; }
  const today = new Date().toISOString().substring(0, 10);
  try {
    const res = await fetch('/api/lineups/' + today);
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Failed');
    STATE.confirmedLineups = {};
    (data.games || []).forEach(g => { STATE.confirmedLineups[g.gamePk] = g; });
    applyConfirmedToPool();
    const poolTeams = new Set(STATE.POOL.map(p => p.team).filter(Boolean));
    const slateGames = poolTeams.size > 0
      ? (data.games || []).filter(g => poolTeams.has(g.homeTeam) || poolTeams.has(g.awayTeam))
      : (data.games || []);
    const confirmedCount = slateGames.filter(g => g.confirmed).length;
    const partialCount   = slateGames.filter(g => g.partialConfirmed && !g.confirmed).length;
    const totalGames = slateGames.length;
    const pendingCount = totalGames - confirmedCount - partialCount;
    const parts = [`${confirmedCount}/${totalGames} games fully confirmed`];
    if (partialCount > 0) parts.push(`${partialCount} partial (1 side posted)`);
    if (pendingCount > 0) parts.push(`${pendingCount} pending`);
    if (el) el.innerHTML = `<div class="ib success">${parts.join(' · ')}</div>`;
    if (btn) { btn.textContent = 'Refresh Lineups'; btn.disabled = false; }
    renderPlayers();
  } catch (e) {
    if (el) el.innerHTML = `<div class="ib warn">Failed: ${esc(e.message)}</div>`;
    if (btn) { btn.textContent = 'Fetch Lineups'; btn.disabled = false; }
  }
}

// ── Late-Scratch Monitor ───────────────────────────────────────────────────────
// Polls /api/lineups/:date every 10 minutes. If any player currently in STATE.lineup
// was previously seen in a confirmed batting order but is now absent → scratch alert.

const _scratchMonitor = {
  active: false,
  timerId: null,
  intervalMs: 10 * 60 * 1000,
  nextPollAt: null,
  countdownId: null,
  alerts: [],           // { name, team, detectedAt }
  // Snapshot of which players were confirmed IN a batting order at monitor-start.
  // We only alert for players who WERE confirmed and then disappear — not for
  // players who were never confirmed (pre-game starters not yet announced).
  baselineConfirmed: new Set(),
  // #13: Per-team baseline precip% at monitor-start. We alert when a team's
  // current precip rises into the rain-risk band from a clearer baseline.
  baselinePrecip: {},   // { teamAbbr: precipChance }
  weatherAlerts: []     // { team, precipNow, precipBase, detectedAt }
};

function normForMonitor(name) {
  return (name || '').toLowerCase().replace(/[^a-z ]/g, '').trim();
}

function buildConfirmedSet(confirmedLineups) {
  // Returns a Set of normalized names who appear in any confirmed batting order.
  const s = new Set();
  Object.values(confirmedLineups).forEach(g => {
    if (!g.confirmed) return;
    [...(g.homeOrder || []), ...(g.awayOrder || [])].forEach(n => s.add(normForMonitor(n)));
  });
  return s;
}

async function pollScratchMonitor() {
  if (!_scratchMonitor.active) return;
  const today = new Date().toISOString().substring(0, 10);
  try {
    const res = await fetch('/api/lineups/' + today);
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'poll failed');

    // Update STATE.confirmedLineups silently
    STATE.confirmedLineups = {};
    (data.games || []).forEach(g => { STATE.confirmedLineups[g.gamePk] = g; });
    applyConfirmedToPool();

    const nowConfirmed = buildConfirmedSet(STATE.confirmedLineups);

    // Check every player currently in STATE.lineup
    const rosteredPlayers = STATE.lineup.filter(Boolean);
    rosteredPlayers.forEach(p => {
      const norm = normForMonitor(p.name);
      // Only alert if: player was confirmed when monitoring started AND now isn't
      if (_scratchMonitor.baselineConfirmed.has(norm) && !nowConfirmed.has(norm)) {
        const already = _scratchMonitor.alerts.some(a => normForMonitor(a.name) === norm);
        if (!already) {
          _scratchMonitor.alerts.push({ name: p.name, team: p.team || '', detectedAt: new Date().toLocaleTimeString() });
        }
      }
    });

    // Update baseline: if new players got confirmed, add them
    nowConfirmed.forEach(n => _scratchMonitor.baselineConfirmed.add(n));

    // #13: Late-rain weather check — refetch weather for all teams in the pool and
    // alert if precip% has risen meaningfully since baseline. Caught delayed convective
    // storms that develop in the hour before first pitch (rain-outs cost full lineups).
    try {
      const teamsInPool = [...new Set(STATE.POOL.filter(p => p.game).map(p => p.team))];
      if (teamsInPool.length) {
        const wRes = await fetch('/api/weather/batch', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ teams: teamsInPool })
        });
        if (wRes.ok) {
          const wData = await wRes.json();
          Object.entries(wData).forEach(([team, w]) => {
            if (!w || w.error || typeof w.precip_chance !== 'number') return;
            const baseline = _scratchMonitor.baselinePrecip[team];
            if (baseline == null) {
              _scratchMonitor.baselinePrecip[team] = w.precip_chance;
              return;
            }
            // Alert if precip jumped from <30% to ≥50% (rain-risk band)
            const triggered = baseline < 30 && w.precip_chance >= 50;
            if (triggered && !_scratchMonitor.weatherAlerts.some(a => a.team === team)) {
              _scratchMonitor.weatherAlerts.push({
                team, precipNow: w.precip_chance, precipBase: baseline,
                detectedAt: new Date().toLocaleTimeString()
              });
            }
            // Track the running baseline as the lowest seen value so a continuously
            // worsening forecast still fires the threshold transition exactly once.
            if (w.precip_chance < baseline) _scratchMonitor.baselinePrecip[team] = w.precip_chance;
          });
          STATE.weatherData = wData;
        }
      }
    } catch (e) { /* weather poll failures are non-fatal — keep monitor running */ }

    _scratchMonitor.lastPollAt = new Date();
    _scratchMonitor.nextPollAt = new Date(Date.now() + _scratchMonitor.intervalMs);
    renderScratchMonitorStatus();
  } catch (e) {
    const statusEl = document.getElementById('scratch-monitor-status');
    if (statusEl) statusEl.innerHTML = `<div class="ib warn">Monitor poll failed: ${esc(e.message)}</div>`;
  }
}

function renderScratchMonitorStatus() {
  const statusEl = document.getElementById('scratch-monitor-status');
  const alertEl  = document.getElementById('scratch-alerts');
  const btn = document.getElementById('scratch-monitor-btn');

  if (!_scratchMonitor.active) {
    if (statusEl) statusEl.innerHTML = '';
    if (btn) { btn.textContent = 'Monitor Scratches'; btn.style.background = ''; }
    return;
  }

  const nextStr = _scratchMonitor.nextPollAt
    ? _scratchMonitor.nextPollAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '—';
  if (statusEl) statusEl.innerHTML = `<div class="ib blue" style="font-size:11px">Monitoring active · next poll ${nextStr}</div>`;
  if (btn) { btn.textContent = 'Stop Monitor'; btn.style.background = 'var(--red, #c0392b)'; }

  if (alertEl) {
    const hasScratch = _scratchMonitor.alerts.length > 0;
    const hasWeather = _scratchMonitor.weatherAlerts.length > 0;
    if (!hasScratch && !hasWeather) {
      alertEl.innerHTML = '';
      return;
    }
    let html = '';
    if (hasScratch) {
      html += `<div style="margin-top:8px;padding:10px 12px;background:#4a1010;border:1px solid #c0392b;border-radius:var(--r)">
        <div style="font-size:12px;font-weight:600;color:#ff6b6b;margin-bottom:6px">SCRATCH ALERT — Rostered Players Missing From Confirmed Lineups</div>
        ${_scratchMonitor.alerts.map((a, idx) =>
          `<div style="font-size:11px;color:#ffaaaa;padding:3px 0">
            <strong>${esc(a.name)}</strong>${a.team ? ' (' + esc(a.team) + ')' : ''} — not in batting order as of ${esc(a.detectedAt)}
            <button onclick="dismissScratchAlert(${idx})" style="margin-left:8px;font-size:10px;padding:1px 6px;background:#c0392b;color:#fff;border:none;border-radius:3px;cursor:pointer">Dismiss</button>
          </div>`
        ).join('')}
      </div>`;
    }
    if (hasWeather) {
      html += `<div style="margin-top:8px;padding:10px 12px;background:#3a2a05;border:1px solid #d4a017;border-radius:var(--r)">
        <div style="font-size:12px;font-weight:600;color:#ffb74d;margin-bottom:6px">RAIN ALERT — Precip Rose Above 50% Since Monitor Started</div>
        ${_scratchMonitor.weatherAlerts.map((a, idx) =>
          `<div style="font-size:11px;color:#ffdfa5;padding:3px 0">
            <strong>${esc(a.team)}</strong> — precip ${a.precipBase}% → ${a.precipNow}% at ${esc(a.detectedAt)}. Consider pivoting batters away from this game.
            <button onclick="dismissWeatherAlert(${idx})" style="margin-left:8px;font-size:10px;padding:1px 6px;background:#d4a017;color:#000;border:none;border-radius:3px;cursor:pointer">Dismiss</button>
          </div>`
        ).join('')}
      </div>`;
    }
    alertEl.innerHTML = html;
  }
}

function dismissWeatherAlert(idx) {
  _scratchMonitor.weatherAlerts.splice(idx, 1);
  renderScratchMonitorStatus();
}

function dismissScratchAlert(idx) {
  _scratchMonitor.alerts.splice(idx, 1);
  renderScratchMonitorStatus();
}

function toggleScratchMonitor() {
  if (_scratchMonitor.active) {
    // Stop
    _scratchMonitor.active = false;
    clearInterval(_scratchMonitor.timerId);
    clearInterval(_scratchMonitor.countdownId);
    _scratchMonitor.timerId = null;
    _scratchMonitor.alerts = [];
    _scratchMonitor.weatherAlerts = [];
    _scratchMonitor.baselineConfirmed.clear();
    _scratchMonitor.baselinePrecip = {};
    renderScratchMonitorStatus();
  } else {
    // Start — snapshot current confirmed players as baseline
    _scratchMonitor.active = true;
    _scratchMonitor.alerts = [];
    _scratchMonitor.baselineConfirmed = buildConfirmedSet(STATE.confirmedLineups);
    // Warn if no roster loaded
    if (!STATE.lineup.filter(Boolean).length) {
      const statusEl = document.getElementById('scratch-monitor-status');
      if (statusEl) statusEl.innerHTML = `<div class="ib warn">No lineup loaded — build a lineup first so the monitor knows which players to watch.</div>`;
    }
    // Run immediately, then on interval
    pollScratchMonitor();
    _scratchMonitor.timerId = setInterval(pollScratchMonitor, _scratchMonitor.intervalMs);
    _scratchMonitor.nextPollAt = new Date(Date.now() + _scratchMonitor.intervalMs);
    renderScratchMonitorStatus();
  }
}

async function checkPostponements() {
  const btn = document.getElementById('check-postponed-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Checking...'; }
  try {
    const today = new Date().toISOString().slice(0, 10);
    const res = await fetch(`/api/postponed/${today}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Failed');

    // Clear previous postponement flags before applying new results
    STATE.POOL.forEach(p => { delete p.isPostponed; });

    if (!data.postponed.length) {
      if (btn) { btn.textContent = 'No Postponements ✓'; btn.className = 'btn-g'; }
      setTimeout(() => { if (btn) { btn.textContent = 'Check Postponements'; btn.className = 'btn'; btn.disabled = false; } }, 2500);
      return;
    }

    const postponedTeams = new Set(data.postponed.flatMap(g => [g.homeTeam, g.awayTeam]));
    let affected = 0;
    STATE.POOL.forEach(p => {
      if (postponedTeams.has(p.team)) { p.isPostponed = true; affected++; }
    });

    const gameList = data.postponed.map(g => `${g.awayTeam}@${g.homeTeam}: ${g.status}`).join('\n');
    alert(`${data.postponed.length} game(s) postponed/cancelled:\n\n${gameList}\n\n${affected} pool player(s) flagged with PPD badge.`);

    if (btn) { btn.textContent = `${data.postponed.length} Postponed!`; }
    invalidatePlayerRenderCache();
    renderPlayers();
  } catch (e) {
    console.error('Postponement check failed:', e);
    if (btn) { btn.textContent = 'Check failed'; }
    setTimeout(() => { if (btn) { btn.textContent = 'Check Postponements'; } }, 2000);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Normalize a player name for confirmed-lineup matching: strip diacritics via NFD
// decomposition (é→e, ó→o, ú→u, etc.) then remove all non-alpha chars.
// Must mirror the key computation used on both sides of the lookup.
function _normConfirmKey(name) {
  return (name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // é→e, ó→o, ñ→n, etc.
    .toLowerCase()
    .replace(/[^a-z ]/g, '')  // strip punctuation (dots, apostrophes, hyphens)
    .replace(/\s+/g, ' ')
    .trim();
}

function applyConfirmedToPool() {
  if (!Object.keys(STATE.confirmedLineups).length) return;
  const orderMap = {};
  const confirmedNames = new Set();
  Object.values(STATE.confirmedLineups).forEach(g => {
    const processOrder = (teamAbbr, orderArr) => {
      orderArr.forEach((name, i) => {
        const key = _normConfirmKey(name);
        orderMap[key] = i + 1;
        confirmedNames.add(key);
      });
    };
    if (g.homeOrder?.length) processOrder(g.homeTeam, g.homeOrder);
    if (g.awayOrder?.length) processOrder(g.awayTeam, g.awayOrder);
  });

  const probablePitchers = new Set();
  Object.values(STATE.confirmedLineups).forEach(g => {
    if (g.homeProbable) probablePitchers.add(_normConfirmKey(g.homeProbable));
    if (g.awayProbable) probablePitchers.add(_normConfirmKey(g.awayProbable));
  });

  // Aggregate order-mismatch reporting: collect all mismatches and emit ONE summary log.
  // Previous behavior produced 5-15 console warnings per fetch (one per player), which
  // drowned out real warnings. We now bucket by severity:
  //   - sync: small shifts (1-2 spots) — normal lineup drift, always silent.
  //   - shift: meaningful shifts (3-4 spots) — counted, summary-logged.
  //   - extreme: 5+ spot shifts — usually a name-match bug; logged individually as warn.
  const orderShifts = [];
  const orderExtremes = [];

  STATE.POOL.forEach(p => {
    const key = _normConfirmKey(p.name);
    if (confirmedNames.has(key) && orderMap[key]) {
      if (p.order && p.order > 0 && p.order !== orderMap[key]) {
        const delta = Math.abs(p.order - orderMap[key]);
        if (delta >= 5) {
          // Extreme shift — likely a name-resolution bug, not real lineup drift
          orderExtremes.push({ name: p.name, csv: p.order, confirmed: orderMap[key] });
        } else if (delta >= 3) {
          orderShifts.push({ name: p.name, csv: p.order, confirmed: orderMap[key] });
        }
      }
      p.confirmedOrder = orderMap[key];
      p.isConfirmed = true;
      p.order = orderMap[key]; // always sync order to confirmed batting position on fetch/refresh
    } else if (rp(p, 'P') && probablePitchers.has(key)) {
      p.isConfirmed = true;
    } else {
      // Clear stale confirmed status on each refresh so scratched players don't persist
      p.isConfirmed = false;
      p.confirmedOrder = null;
    }
  });

  // Emit aggregated order-shift report (replaces per-player console.warn spam).
  // - Extreme shifts (≥5 spots) get individual warnings — they typically signal name-match bugs.
  // - Moderate shifts (3-4 spots) get a single summary line.
  // - Small shifts (1-2 spots) are silent — normal pre-game lineup adjustments.
  if (orderExtremes.length > 0) {
    orderExtremes.forEach(e => {
      console.warn(`[OrderSync] Extreme shift for ${e.name}: CSV order=${e.csv}, confirmed=${e.confirmed} — verify the name matches the right player.`);
    });
  }
  if (orderShifts.length > 0) {
    dlog(`[OrderSync] ${orderShifts.length} players shifted 3-4 spots from CSV to confirmed order (PA multipliers updated).`,
      orderShifts.slice(0, 5).map(s => `${s.name}: ${s.csv}→${s.confirmed}`).join(', ') + (orderShifts.length > 5 ? '…' : ''));
  }
}

// ── Statcast Data ─────────────────────────────────────────────────────────────
async function loadStatcast() {
  const btn = document.getElementById('fetch-statcast-btn');
  const el = document.getElementById('statcast-status');
  if (btn) { btn.textContent = 'Loading...'; btn.disabled = true; }
  try {
    const res = await fetch('/api/statcast');
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Failed');
    STATE.statcastData = data.data || {};
    applyStatcastToPool();
    const matchCount = STATE.POOL.filter(p => {
      const key = p.name.toLowerCase().replace(/[^a-z ]/g, '').trim();
      return !!STATE.statcastData[key];
    }).length;
    if (el) {
      const cacheInfo = data.cached ? ` (cached ${new Date(data.fetchedAt).toLocaleDateString()})` : '';
      const staleWarn = cacheAgeWarning(data.fetchedAt);
      el.innerHTML = `<div class="ib success">Loaded ${data.count} Statcast profiles · ${matchCount} matched to player pool${cacheInfo}${staleWarn}</div>`;
    }
    if (btn) { btn.textContent = 'Refresh Statcast'; btn.disabled = false; }
    renderPlayers();
    renderBlendControls();
    // Also load pitcher Statcast for stuff model
    loadPitcherStatcast();
    // Load bullpen quality rankings
    loadBullpen();
    // Load catcher framing data
    loadFraming();
    // Load sprint speed data
    loadSprintSpeed();
    // Load season rate stats for internal projections
    loadSeasonStats();
  } catch (e) {
    if (el) el.innerHTML = `<div class="ib warn">Statcast failed: ${esc(e.message)}</div>`;
    if (btn) { btn.textContent = 'Fetch Statcast'; btn.disabled = false; }
  }
}

function applyStatcastToPool() {
  STATE.POOL.forEach(p => {
    const key = p.name.toLowerCase().replace(/[^a-z ]/g, '').trim();
    if (rp(p, 'P')) {
      // Apply pitcher Statcast "stuff" metrics
      const sc = STATE.pitcherStatcastData[key];
      if (sc) {
        p.whiffRate = sc.whiffRate;
        p.fastballVelo = sc.fastballVelo;
        p.hardHitRate = sc.hardHitRate;
        p.xERA = sc.xERA;
        p.xBA = sc.xBA;
        p.scKPercent = sc.kPercent;
        p.scBBPercent = sc.bbPercent;
      }
    } else {
      const sc = STATE.statcastData[key];
      if (sc) {
        p.barrelRate = sc.barrelRate;
        p.hardHitRate = sc.hardHitRate;
        p.xwOBA = sc.xwOBA;
        p.xSLG = sc.xSLG;
        p.exitVelo = sc.exitVelo;
      }
    }
  });
}

// ── Pitcher Statcast ("Stuff" Model) ──────────────────────────────────────────
async function loadPitcherStatcast() {
  const el = document.getElementById('statcast-status');
  try {
    const res = await fetch('/api/statcast/pitchers');
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Failed');
    STATE.pitcherStatcastData = data.data || {};
    applyStatcastToPool();
    const pitchers = STATE.POOL.filter(p => rp(p, 'P'));
    const matchCount = pitchers.filter(p => {
      const key = p.name.toLowerCase().replace(/[^a-z ]/g, '').trim();
      return !!STATE.pitcherStatcastData[key];
    }).length;
    if (el) {
      const existing = el.innerHTML;
      const pInfo = ` · Pitcher stuff: ${data.count} profiles, ${matchCount} matched${cacheAgeWarning(data.fetchedAt)}`;
      el.innerHTML = existing + pInfo;
    }
    renderPlayers();
  } catch (e) {
    if (el) {
      const existing = el.innerHTML;
      el.innerHTML = existing + ` · <span class="warn">Pitcher Statcast failed</span>`;
    }
  }
}

// ── Season Rate Stats (internal projection anchor) ────────────────────────────
async function loadSeasonStats() {
  const el = document.getElementById('statcast-status');
  try {
    const res = await fetch('/api/season-stats');
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Failed');
    STATE.seasonStatsData = { batters: data.batters || {}, pitchers: data.pitchers || {} };
    // Re-apply internal projections now that we have season stats
    applyInternalProjections();
    if (el) {
      const existing = el.innerHTML;
      const cacheNote = data.stale ? ' (stale)' : data.cached ? ' (cached)' : '';
      el.innerHTML = existing + ` · Season stats: ${data.batterCount}B/${data.pitcherCount}P${cacheNote}`;
    }
  } catch (e) {
    if (el) {
      const existing = el.innerHTML;
      el.innerHTML = existing + ` · <span class="warn">Season stats failed</span>`;
    }
  }
}

function applyInternalProjections() {
  if (!STATE.seasonStatsData || !STATE.POOL.length) return;
  if (!Engine.buildInternalProjections) return;
  const ctx = { vegasData: STATE.vegasData };
  const updated = Engine.buildInternalProjections(STATE.POOL, STATE.seasonStatsData, ctx.vegasData);
  // Apply only changed projections back to pool (preserve reference for players without internal data)
  updated.forEach((p, i) => {
    if (p.hasInternalProj && !STATE.POOL[i].hasInternalProj) {
      STATE.POOL[i] = p;
    }
  });
  runOwnershipAudit();
  renderPlayers();
}

async function loadBullpen() {
  const el = document.getElementById('statcast-status');
  try {
    const res = await fetch('/api/bullpen');
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Failed');
    STATE.bullpenData = data.data || {};
    const teamCount = Object.keys(STATE.bullpenData).length;
    if (el) {
      const existing = el.innerHTML;
      el.innerHTML = existing + ` · Bullpen: ${teamCount} teams${cacheAgeWarning(data.fetchedAt)}`;
    }
  } catch (e) {
    if (el) {
      const existing = el.innerHTML;
      el.innerHTML = existing + ` · <span class="warn">Bullpen data failed</span>`;
    }
  }
}

async function loadFraming() {
  const el = document.getElementById('statcast-status');
  try {
    const res = await fetch('/api/framing');
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Failed');
    STATE.framingRawData = data.data || {};
    // Build team-level framing map from catchers in the pool
    STATE.framingMap = {};
    const catchers = STATE.POOL.filter(p => rp(p, 'C') || (p.pos && p.pos.includes('C')));
    for (const c of catchers) {
      const key = c.name.toLowerCase().replace(/[^a-z ]/g, '').trim();
      const fd = STATE.framingRawData[key];
      if (fd) {
        // Use highest-salary catcher per team as the likely starter
        if (!STATE.framingMap[c.team] || c.salary > (STATE.framingMap[c.team]._salary || 0)) {
          STATE.framingMap[c.team] = { framingRunsPerGame: fd.framingRunsPerGame, name: fd.name, _salary: c.salary };
        }
      }
    }
    const matchCount = Object.keys(STATE.framingMap).length;
    if (el) {
      const existing = el.innerHTML;
      el.innerHTML = existing + ` · Framing: ${data.count} catchers, ${matchCount} teams matched${cacheAgeWarning(data.fetchedAt)}`;
    }
  } catch (e) {
    if (el) {
      const existing = el.innerHTML;
      el.innerHTML = existing + ` · <span class="warn">Framing data failed</span>`;
    }
  }
}

async function loadSprintSpeed() {
  const el = document.getElementById('statcast-status');
  try {
    const res = await fetch('/api/sprint-speed');
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Failed');
    STATE.sprintSpeedData = data.data || {};
    const matchCount = STATE.POOL.filter(p => {
      const key = p.name.toLowerCase().replace(/[^a-z ]/g, '').trim();
      return !!STATE.sprintSpeedData[key];
    }).length;
    if (el) {
      const existing = el.innerHTML;
      el.innerHTML = existing + ` · Sprint: ${data.count} runners, ${matchCount} matched${cacheAgeWarning(data.fetchedAt)}`;
    }
  } catch (e) {
    if (el) {
      const existing = el.innerHTML;
      el.innerHTML = existing + ` · <span class="warn">Sprint speed failed</span>`;
    }
  }
}

// ── Recent Form ───────────────────────────────────────────────────────────────
async function loadRecentForm() {
  const btn = document.getElementById('fetch-form-btn');
  const el = document.getElementById('form-status');
  if (btn) { btn.textContent = 'Loading...'; btn.disabled = true; }
  try {
    const res = await fetch('/api/form');
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Failed');
    STATE.formData = data.data || {};
    applyFormToPool();
    const matchCount = STATE.POOL.filter(p => {
      const key = p.name.toLowerCase().replace(/[^a-z ]/g, '').trim();
      return !!STATE.formData[key];
    }).length;
    if (el) {
      el.innerHTML = `<div class="ib success">Loaded ${data.playerCount} players · ${matchCount} matched · last 14 days${data.stale ? ' (stale)' : ''}</div>`;
    }
    if (btn) { btn.textContent = 'Refresh Form'; btn.disabled = false; }
    renderPlayers();
    renderBlendControls();
  } catch (e) {
    if (el) el.innerHTML = `<div class="ib warn">Form fetch failed: ${esc(e.message)}</div>`;
    if (btn) { btn.textContent = 'Fetch Form'; btn.disabled = false; }
  }
}

function applyFormToPool() {
  STATE.POOL.forEach(p => {
    const key = p.name.toLowerCase().replace(/[^a-z ]/g, '').trim();
    const f = STATE.formData[key];
    if (f) {
      p.recentAvgDK = f.avgDK;
      p.recentGames = f.games;
      p.recentBA = f.ba;
      if (rp(p, 'P')) {
        p.kRate = f.kPer9 || p.kRate || 0;
        p.recentERA = f.era;
        p.recentWHIP = f.whip;
      }
    }
  });
}

// ── Injury Feed ───────────────────────────────────────────────────────────────
async function loadInjuries() {
  const btn = document.getElementById('fetch-injuries-btn');
  const status = document.getElementById('injuries-status');
  if (btn) { btn.textContent = 'Loading…'; btn.disabled = true; }
  try {
    const res = await fetch('/api/injuries');
    if (!res.ok && res.headers.get('content-type')?.includes('text/html')) {
      throw new Error('Server returned an unexpected response — is the server running?');
    }
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Failed');
    STATE.injuryData = data.flagged || [];
    applyInjuriesToPool();
    renderPlayers();
    const gtd = STATE.injuryData.filter(p => p.type === 'GTD').length;
    const il = STATE.injuryData.filter(p => p.type === 'IL').length;
    const noteText = data.note ? ` — ${esc(data.note)}` : '';
    if (status) status.innerHTML = `<span class="pill ${STATE.injuryData.length ? 'pw' : 'pg'}">${STATE.injuryData.length} flags: ${il} IL, ${gtd} GTD (last 48h)${noteText}</span>`;
  } catch (e) {
    if (status) status.innerHTML = `<span class="pill pd">Injury fetch failed: ${esc(e.message)}</span>`;
  } finally {
    if (btn) { btn.textContent = 'Fetch Injuries'; btn.disabled = false; }
  }
}

function applyInjuriesToPool() {
  // Index by normalized key (accent-stripped, punctuation-removed) so "José García"
  // matches "Jose Garcia" in the pool. No substring fallback — the old .includes() check
  // caused false positives (e.g. "Al" matched "Albert", "Smith" matched "Smith Jr.").
  const flagMap = {};
  STATE.injuryData.forEach(f => { flagMap[_normConfirmKey(f.name)] = f; });
  STATE.POOL.forEach(p => {
    const key = _normConfirmKey(p.name);
    const flag = flagMap[key] || null;
    p.injuryFlag = !!flag;
    p.injuryType = flag?.type || null;
    p.injuryDesc = flag?.description || null;
  });
}

// ── Umpire Data ────────────────────────────────────────────────────────────────
async function loadUmpires() {
  const btn = document.getElementById('fetch-umpires-btn');
  const status = document.getElementById('umpires-status');
  if (btn) { btn.textContent = 'Loading…'; btn.disabled = true; }
  try {
    const today = new Date().toISOString().split('T')[0];
    const res = await fetch(`/api/umpires/${today}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Failed');
    // Build homeTeam → tendency map
    STATE.umpireData = {};
    (data.assignments || []).forEach(g => {
      if (g.homeTeam && g.tendency) STATE.umpireData[g.homeTeam] = g.tendency;
    });
    const known = Object.values(STATE.umpireData).filter(u => u.score !== undefined).length;
    const total = Object.keys(STATE.umpireData).length;
    if (status) status.innerHTML = `<span class="pill ${known ? 'psu' : 'pi'}">${total} games — ${known} umpires in DB</span>`;
    renderSlateEnvironment();
  } catch (e) {
    if (status) status.innerHTML = `<span class="pill pd">Umpire fetch failed: ${esc(e.message)}</span>`;
  } finally {
    if (btn) { btn.textContent = 'Fetch Umpires'; btn.disabled = false; }
  }
}

// ── DvP (Defense vs. Position) ───────────────────────────────────────────────
async function loadDvP() {
  const btn = document.getElementById('fetch-dvp-btn');
  const status = document.getElementById('dvp-status');
  if (btn) { btn.textContent = 'Loading…'; btn.disabled = true; }
  try {
    const res = await fetch('/api/dvp');
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Failed');
    STATE.dvpData = data.data || {};
    const teams = Object.keys(STATE.dvpData).length;
    const cached = data.cached ? ' (cached)' : '';
    const stale = data.stale ? ' ⚠ stale' : '';
    if (status) status.innerHTML = `<span class="pill ${teams ? 'psu' : 'pi'}">${teams} teams${cached}${stale}</span>`;
    renderDvP();
  } catch (e) {
    if (status) status.innerHTML = `<span class="pill pd">DvP fetch failed: ${esc(e.message)}</span>`;
  } finally {
    if (btn) { btn.textContent = 'Fetch DvP Data'; btn.disabled = false; }
  }
}

function renderDvP() {
  const el = document.getElementById('dvp-table');
  if (!el) return;
  const teams = Object.keys(STATE.dvpData).sort();
  if (!teams.length) {
    el.innerHTML = '<div class="empty" style="padding:12px">Click "Fetch DvP Data" to load 14-day defense vs. position stats.</div>';
    return;
  }
  const positions = ['P', 'C', '1B', '2B', '3B', 'SS', 'OF'];

  // Color: green = easy matchup (high allowed), red = tough
  const rankColor = (rank, total) => {
    if (!rank || !total) return '';
    const pct = rank / total;
    if (pct <= 0.25) return 'color:var(--tsu);font-weight:600';   // top 25% = easy
    if (pct >= 0.75) return 'color:var(--td);font-weight:600';    // bottom 25% = tough
    return 'color:var(--ts)';
  };

  // Filter to only teams in current slate if pool loaded
  const slateTeams = STATE.POOL.length ? new Set(STATE.POOL.map(p => p.team)) : null;
  const displayTeams = slateTeams ? teams.filter(t => slateTeams.has(t)) : teams;
  const showAll = document.getElementById('dvp-show-all')?.checked;
  const filteredTeams = (!slateTeams || showAll) ? teams : displayTeams;

  let html = `<div style="margin-bottom:6px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
    ${slateTeams ? `<label style="font-size:11px;display:flex;align-items:center;gap:4px;cursor:pointer"><input type="checkbox" id="dvp-show-all" ${showAll ? 'checked' : ''} onchange="renderDvP()"> Show all 30 teams</label>` : ''}
    <span style="font-size:10px;color:var(--tt)"><span style="color:var(--tsu)">■</span> easy matchup &nbsp;<span style="color:var(--td)">■</span> tough matchup (rank 1 = most pts allowed)</span>
  </div>`;

  html += `<div style="overflow-x:auto"><table style="width:100%;font-size:11px;min-width:560px">
    <thead><tr>
      <th style="text-align:left">Team (Def)</th>
      ${positions.map(p => `<th title="Avg DK pts allowed to ${p} per game">${p}</th>`).join('')}
    </tr></thead>
    <tbody>`;

  filteredTeams.forEach(team => {
    const pd = STATE.dvpData[team] || {};
    html += `<tr><td><strong>${esc(team)}</strong></td>`;
    positions.forEach(pos => {
      const d = pd[pos];
      if (!d) { html += '<td style="color:var(--tt)">—</td>'; return; }
      const style = rankColor(d.rank, d.totalTeams);
      const rankLabel = d.rank && d.totalTeams ? ` <span style="font-size:9px;color:var(--tt)">#${d.rank}</span>` : '';
      html += `<td style="${style}" title="Avg ${d.avgAllowed} DK pts/game (rank ${d.rank}/${d.totalTeams})">${d.avgAllowed}${rankLabel}</td>`;
    });
    html += '</tr>';
  });

  html += '</tbody></table></div>';
  if (!showAll && slateTeams && displayTeams.length < teams.length) {
    html += `<div style="font-size:10px;color:var(--tt);margin-top:4px">Showing ${displayTeams.length} slate teams. Check "Show all 30 teams" to see the full table.</div>`;
  }
  el.innerHTML = html;
}

// ── Wind Effects ──────────────────────────────────────────────────────────────
async function loadWindEffects() {
  if (!STATE.weatherData || !STATE.stadiumData) return;
  STATE.windEffects = {};
  const teams = [...new Set(STATE.POOL.map(p => p.team).filter(Boolean))];
  for (const team of teams) {
    // Weather is now keyed by team code (GPS-accurate)
    if (!STATE.weatherData[team]) continue;
    const w = STATE.weatherData[team];
    if (w.error) continue;
    try {
      const res = await fetch(`/api/wind-effect/${team}?wind_dir=${encodeURIComponent(w.wind_dir || '')}&wind_mph=${w.wind_mph || 0}`);
      const data = await res.json();
      STATE.windEffects[team] = data.effect || 0;
    } catch (e) { STATE.windEffects[team] = 0; }
  }
}

// ── Slate Environment (Game Summary) ─────────────────────────────────────────
function renderSlateEnvironment() {
  const el = document.getElementById('slate-environment');
  if (!el) return;
  const games = [...new Set(STATE.POOL.map(p => p.game).filter(Boolean))];
  if (!games.length) {
    el.innerHTML = '<div class="empty" style="padding:12px">Load player data to see game environment rankings.</div>';
    return;
  }

  const gameEnvs = games.map(game => {
    const [away, home] = game.split('@');
    const homeVegas = STATE.vegasData?.[home] || {};
    const awayVegas = STATE.vegasData?.[away] || {};
    const total = (homeVegas.impliedTotal || 0) + (awayVegas.impliedTotal || 0);
    const pf = STATE.parkFactors?.[home] || { overall: 1.0, hr: 1.0 };
    const isDome = STATE.stadiumData?.domes?.includes(home);
    // Weather is now keyed by team code (GPS-accurate)
    const weather = STATE.weatherData?.[home] && !STATE.weatherData[home].error ? STATE.weatherData[home] : null;
    const wm = weather ? Engine.weatherMultiplier(weather) : { hitting: 1.0, risk: 'none' };
    const we = STATE.windEffects[home] || 0;
    const windLabel = we > 0.3 ? 'OUT' : we < -0.3 ? 'IN' : 'N';
    const envScore = total * pf.overall * wm.hitting * (isDome ? 1.0 : 1.0);
    return { game, away, home, total, homeImplied: homeVegas.impliedTotal || 0,
      awayImplied: awayVegas.impliedTotal || 0, pf, weather, wm, isDome, windLabel, we, envScore };
  }).filter(g => g.total > 0 || !STATE.vegasData).sort((a, b) => b.envScore - a.envScore);

  if (!gameEnvs.length) {
    el.innerHTML = '<div class="empty" style="padding:12px">Enter Vegas lines to see game environment rankings.</div>';
    return;
  }

  function envMoveBadge(curr, open) {
    if (open == null || curr == null || !open || !curr) return '';
    const diff = +(curr - open).toFixed(1);
    if (Math.abs(diff) < 0.1) return '';
    const up = diff > 0;
    return ` <span style="font-size:9px;color:${up ? 'var(--tsu)' : 'var(--td)'}">${up ? '▲' : '▼'}${Math.abs(diff).toFixed(1)}</span>`;
  }

  el.innerHTML = `<div class="tbl-wrap"><table>
    <thead><tr><th>Game</th><th>O/U</th><th>Away Impl</th><th>Home Impl</th><th>Park</th><th>Weather</th><th>Wind</th><th>Rain</th><th>HP Ump</th><th>Env Score</th></tr></thead>
    <tbody>${gameEnvs.map((g, i) => {
      const rankColor = i === 0 ? 'var(--tsu)' : i < 3 ? 'var(--ti)' : 'var(--ts)';
      const rainRisk = g.weather?.precip_chance || 0;
      const rainColor = rainRisk >= 50 ? 'var(--td)' : rainRisk >= 30 ? 'var(--tw)' : 'var(--tsu)';
      const ump = STATE.umpireData[g.home];
      const umpCell = ump
        ? `<span title="${escAttr(ump.name || '')}" class="pill ${ump.score >= 1 ? 'pd' : ump.score <= -1 ? 'psu' : 'pg'}" style="font-size:10px">${esc(ump.name || 'Unk')} ${ump.score > 0 ? '+' : ''}${ump.score ?? ''}</span>`
        : '\u2014';
      const awayVD = STATE.vegasData?.[g.away] || {};
      const homeVD = STATE.vegasData?.[g.home] || {};
      return `<tr>
        <td><strong style="color:${rankColor}">#${i+1} ${esc(g.away)}@${esc(g.home)}</strong></td>
        <td><strong>${g.total > 0 ? g.total.toFixed(1) : '\u2014'}</strong></td>
        <td>${g.awayImplied > 0 ? g.awayImplied.toFixed(1) : '\u2014'}${envMoveBadge(awayVD.impliedTotal, awayVD.openTotal)}</td>
        <td>${g.homeImplied > 0 ? g.homeImplied.toFixed(1) : '\u2014'}${envMoveBadge(homeVD.impliedTotal, homeVD.openTotal)}</td>
        <td><span class="pill ${g.pf.overall > 1.05 ? 'psu' : g.pf.overall < 0.95 ? 'pd' : 'pg'}">${g.pf.overall.toFixed(2)}</span></td>
        <td>${g.isDome ? '<span class="pill pg">Dome</span>' : g.weather ? `${g.weather.temp_f}F` : '\u2014'}</td>
        <td><span class="pill ${g.windLabel === 'OUT' ? 'psu' : g.windLabel === 'IN' ? 'pd' : 'pg'}">${g.windLabel}</span></td>
        <td style="color:${rainColor}">${rainRisk > 0 ? rainRisk + '%' : '\u2014'}</td>
        <td>${umpCell}</td>
        <td style="color:${rankColor};font-weight:500">${g.envScore > 0 ? g.envScore.toFixed(1) : '\u2014'}</td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;

  // Auto-refresh Slate Summary if it's open — vegas/weather data just changed
  if (document.getElementById('panel-slate')?.classList.contains('active')) {
    renderSlateSummary();
  }
}

// ── Value Scatter Plot (SVG) ───────────────────────────────────────────────────
function renderValueScatter() {
  const el = document.getElementById('value-scatter');
  if (!el || !STATE.POOL.length) return;
  const W = Math.min(el.offsetWidth || 500, 600), H = 280;
  const PAD = { left: 40, right: 20, top: 15, bottom: 35 };
  const data = STATE.POOL.filter(p => p.salary > 0 && p.median > 0);
  if (data.length < 5) { el.innerHTML = '<div class="empty" style="padding:20px">Need salary + projection data for scatter.</div>'; return; }

  // Use reduce instead of spread — avoid stack overflow risk on large pools (300+ players)
  let minSal = Infinity, maxSal = 0, maxMed = 0;
  for (const p of data) {
    if (p.salary < minSal) minSal = p.salary;
    if (p.salary > maxSal) maxSal = p.salary;
    if (p.median > maxMed) maxMed = p.median;
  }
  const posColors = { P:'#4a9de0', C:'#e0884a', '1B':'#4ae068', '2B':'#b44ae0', '3B':'#e04a4a', SS:'#e0c44a', OF:'#4ae0c4' };

  const scaleX = (s) => PAD.left + (s - minSal) / (maxSal - minSal) * (W - PAD.left - PAD.right);
  const scaleY = (m) => H - PAD.bottom - (m / maxMed) * (H - PAD.top - PAD.bottom);

  // Store data reference for click handler
  el._scatterData = data;

  const dots = data.map((p, idx) => {
    const x = scaleX(p.salary), y = scaleY(p.median);
    const pos = (p.dkPos || '').split('/')[0];
    const col = posColors[pos] || posColors[rp(p, 'P') ? 'P' : 'OF'] || '#888';
    const isInLu = STATE.lineup.some(lp => lp && lp.name === p.name);
    const cursor = isInLu ? 'default' : 'pointer';
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${isInLu ? 6 : 3.5}" fill="${col}" opacity="${isInLu ? 1 : 0.6}" stroke="${isInLu ? '#fff' : 'none'}" stroke-width="1.5" style="cursor:${cursor}" data-idx="${idx}" class="scatter-dot">
      <title>${esc(p.name)} (${esc(p.dkPos)}) $${p.salary.toLocaleString()} / ${p.median.toFixed(1)}pts${p.own > 0 ? ' / ' + p.own.toFixed(1) + '%own' : ''}${isInLu ? ' ✓ in lineup' : ' — click to add'}</title>
    </circle>`;
  }).join('');

  el.innerHTML = `<div style="font-size:10px;color:var(--tt);margin-bottom:4px">Click a dot to add player to lineup</div>
  <svg width="${W}" height="${H}" style="display:block;overflow:visible">
    <line x1="${PAD.left}" y1="${H - PAD.bottom}" x2="${W - PAD.right}" y2="${H - PAD.bottom}" stroke="var(--brd-t)" stroke-width="0.5"/>
    <line x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${H - PAD.bottom}" stroke="var(--brd-t)" stroke-width="0.5"/>
    <text x="${(W + PAD.left - PAD.right) / 2}" y="${H - 5}" font-size="10" fill="var(--tt)" text-anchor="middle">Salary →</text>
    <text x="10" y="${(H + PAD.top - PAD.bottom) / 2}" font-size="10" fill="var(--tt)" text-anchor="middle" transform="rotate(-90 10 ${(H + PAD.top - PAD.bottom) / 2})">Median</text>
    ${dots}
    <g transform="translate(${PAD.left + 5}, ${PAD.top + 5})">
      ${Object.entries(posColors).map(([pos, col], i) =>
        `<g transform="translate(${(i % 4) * 38}, ${Math.floor(i / 4) * 14})"><circle cx="0" cy="0" r="3.5" fill="${col}"/><text x="6" y="4" font-size="9" fill="var(--ts)">${pos}</text></g>`
      ).join('')}
    </g>
  </svg>`;

  // Wire up click handler
  el.querySelector('svg').addEventListener('click', e => {
    const dot = e.target.closest('.scatter-dot');
    if (!dot) return;
    const idx = parseInt(dot.dataset.idx);
    const p = el._scatterData[idx];
    if (p) { addToLineup(p); renderValueScatter(); }
  });
}

// ── Position Scarcity ─────────────────────────────────────────────────────────
function checkPositionScarcity() {
  const el = document.getElementById('position-scarcity');
  if (!el || !STATE.POOL.length) return;
  // Showdown has no position requirements — scarcity warnings don't apply
  if (isShowdown()) { el.style.display = 'none'; return; }
  const usedNames = new Set(STATE.lineup.filter(Boolean).map(p => p.name));
  const budget = CAP - getSalaryUsed();
  const warns = [];

  const posCheck = [
    { key: 'C', label: 'C', minViable: 4 },
    { key: '2B', label: '2B', minViable: 5 },
    { key: 'SS', label: 'SS', minViable: 5 },
    { key: '3B', label: '3B', minViable: 5 },
  ];

  posCheck.forEach(({ key, label, minViable }) => {
    const already = STATE.lineup.filter(Boolean).some(p => rp(p, key));
    if (already) return;
    const available = STATE.POOL.filter(p => rp(p, key) && !usedNames.has(p.name) && p.salary <= budget && p.salary > 0).length;
    if (available < minViable) {
      warns.push(`<span class="pill ${available < 2 ? 'pd' : 'pw'}">${label}: only ${available} viable</span>`);
    }
  });

  el.style.display = warns.length ? 'flex' : 'none';
  if (warns.length) el.innerHTML = warns.join(' ');
}

// ── Projection Blend UI ───────────────────────────────────────────────────────
// Default weights: Statcast=100, Form Batters=0 (opt-in), Form Pitchers=0 (low signal
// from 14-day pitcher ERA), Platoon=0 (CSVs already price in matchup splits).
const BLEND_DEFAULTS = {
  'ROO': 100, 'Statcast': 100,
  'Form (14d) Batters': 0, 'Form (14d) Pitchers': 0,
  // Legacy combined key — kept so old saved sessions don't lose the value.
  'Form (14d)': 0, 'Platoon': 0
};

function renderBlendControls() {
  const el = document.getElementById('blend-controls');
  if (!el) return;

  const sources = [];
  if (STATE.ROO.length) sources.push({ name: 'ROO', count: STATE.ROO.length });
  if (STATE.statcastData && Object.keys(STATE.statcastData).length) sources.push({ name: 'Statcast', count: Object.keys(STATE.statcastData).length });
  if (STATE.formData && Object.keys(STATE.formData).length) sources.push({ name: 'Form (14d) Batters', count: Object.keys(STATE.formData).length });
  if (STATE.formData && Object.keys(STATE.formData).length) sources.push({ name: 'Form (14d) Pitchers', count: Object.keys(STATE.formData).length });
  const internalCount = STATE.POOL.filter(p => p.hasInternalProj && !p.hasRoo).length;
  if (internalCount > 0) sources.push({ name: 'Internal Proj', count: internalCount });

  // Source-aware flags row — shown whenever ROO is loaded, regardless of source count.
  // These tell the engine whether the projection CSV already prices in park/Vegas so
  // those multipliers can be suppressed to prevent double-counting.
  const srcFlagsHtml = STATE.ROO.length ? `
    <div style="margin-bottom:8px;padding:8px;background:var(--bs);border-radius:4px;border:0.5px solid var(--brd-s)">
      <div style="font-size:11px;color:var(--ts);margin-bottom:4px"><strong>Projection source already includes:</strong> <span style="color:var(--tt);font-weight:400">(uncheck if your source is raw — leaves park/Vegas multipliers active)</span></div>
      <label style="font-size:11px;color:var(--ts);margin-right:14px;cursor:pointer">
        <input type="checkbox" id="src-includes-park" ${STATE.sourceIncludesPark ? 'checked' : ''}
          onchange="STATE.sourceIncludesPark=this.checked;saveSession();renderPlayers&&renderPlayers()"
          style="vertical-align:middle"> Park factors
      </label>
      <label style="font-size:11px;color:var(--ts);cursor:pointer">
        <input type="checkbox" id="src-includes-vegas" ${STATE.sourceIncludesVegas ? 'checked' : ''}
          onchange="STATE.sourceIncludesVegas=this.checked;saveSession();renderPlayers&&renderPlayers()"
          style="vertical-align:middle"> Vegas implied totals
      </label>
    </div>` : '';

  if (sources.length < 2) {
    el.innerHTML = srcFlagsHtml + `<span style="font-size:11px;color:var(--tt)">
      ${STATE.ROO.length ? 'Load Statcast or 14-Day Form data above to enable blending.' : 'Upload a ROO projection file to begin.'}
    </span>`;
    return;
  }

  el.innerHTML = srcFlagsHtml + `<div style="font-size:11px;color:var(--ts);margin-bottom:6px">Active data sources — adjust projection scoring weights:</div>
  <div style="display:flex;flex-wrap:wrap;gap:12px">
    ${sources.map(s => {
      const wKey = 'blend-' + s.name.replace(/\W/g, '');
      const defaultW = BLEND_DEFAULTS[s.name] ?? 100;
      const current = STATE.blendWeights[s.name] ?? defaultW;
      const isDisabled = defaultW === 0 && current === 0;
      const label = s.name;
      const hint = '';
      return `<div style="display:flex;flex-direction:column;gap:3px;min-width:120px">
        <label style="font-size:11px;color:${isDisabled ? 'var(--tt)' : 'var(--ts)'}"${hint}>${esc(label)} <span style="color:var(--ts)">(${s.count})</span></label>
        <div style="display:flex;align-items:center;gap:6px">
          <input type="range" id="${wKey}" min="0" max="100" value="${current}" style="flex:1"
            oninput="STATE.blendWeights['${esc(s.name)}']=parseInt(this.value);document.getElementById('${wKey}-lbl').textContent=this.value+'%';saveSession()">
          <span id="${wKey}-lbl" style="font-size:11px;color:var(--ts);width:32px">${current}%</span>
        </div>
      </div>`;
    }).join('')}
  </div>
  <div style="font-size:10px;color:var(--tt);margin-top:6px">Weights adjust scoring multipliers. ⚠ = off by default. Re-run Auto-fill or Generate to apply.</div>`;
}

// ── Pool CSV Export ───────────────────────────────────────────────────────────
function exportPool() {
  if (!STATE.POOL.length) return;
  const headers = [
    'Name','Pos','Team','Opp','Game','Salary','BatOrder',
    'Floor','Median','Ceiling','Own%','Leverage','GPPScore','OptExp%','AvgPPG',
    'BarrelRate','HardHit%','xwOBA','RecentAvgDK','RecentGames','KRate',
    'IsConfirmed','ConfirmedOrder','InjuryType','InjuryDesc'
  ];
  const rows = STATE.POOL.map(p => [
    p.name, p.dkPos || p.rosterPos || '', p.team || '', p.opp || '', p.game || '',
    p.salary || 0, p.order || 0,
    p.floor != null ? p.floor.toFixed(2) : '',
    p.median != null ? p.median.toFixed(2) : '',
    p.ceiling != null ? p.ceiling.toFixed(2) : '',
    p.own != null ? p.own.toFixed(2) : '',
    p.lev != null ? p.lev.toFixed(2) : '',
    Engine.calcGppScore(p, STATE.contestSize).toFixed(2),
    p.optExp != null ? p.optExp.toFixed(1) : '',
    p.avgPpg != null ? p.avgPpg.toFixed(2) : '',
    p.barrelRate != null ? p.barrelRate.toFixed(1) : '',
    p.hardHitRate != null ? p.hardHitRate.toFixed(1) : '',
    p.xwOBA != null ? p.xwOBA.toFixed(3) : '',
    p.recentAvgDK != null ? p.recentAvgDK.toFixed(2) : '',
    p.recentGames || '',
    p.kRate != null ? p.kRate.toFixed(1) : '',
    p.isConfirmed ? 'Y' : '',
    p.confirmedOrder || '',
    p.injuryType || '',
    p.injuryDesc || ''
  ].map(csvQuote));

  const csv = [headers.map(csvQuote).join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const date = new Date().toISOString().split('T')[0];
  a.download = `mlb_dfs_pool_${date}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── localStorage Persistence ──────────────────────────────────────────────────
const LS_KEY = 'mlbdfs_session';

function saveSession() {
  try {
    const session = {
      blendWeights: STATE.blendWeights,
      contestSize: STATE.contestSize,
      sourceIncludesPark: STATE.sourceIncludesPark,
      sourceIncludesVegas: STATE.sourceIncludesVegas,
      lineup: STATE.lineup.map(p => p ? { name: p.name } : null),
      lockedSlots: STATE.lockedSlots ? [...STATE.lockedSlots] : null,
      contestTypeSel: document.getElementById('contest-type-sel')?.value,
      allowBvP: document.getElementById('allow-bvp')?.checked || false,
      simulatorConfig: {
        simCount: document.getElementById('sim-count')?.value,
        corrScale: document.getElementById('sim-corr-scale')?.value,
        simDiversity: document.getElementById('sim-diversity')?.value,
      },
      portConfig: {
        numLineups: document.getElementById('port-num-lineups')?.value,
        maxExposure: document.getElementById('port-max-exposure')?.value,
        maxPitcher: document.getElementById('port-max-pitcher')?.value,
        contestType: document.getElementById('port-contest-type')?.value,
        contestSize: document.getElementById('port-contest-size')?.value,
        maxOverlap: document.getElementById('port-max-overlap')?.value,
        minImplied: document.getElementById('port-min-implied')?.value,
        minGameTotal: document.getElementById('port-min-game-total')?.value,
        maxOppK9: document.getElementById('port-max-opp-k9')?.value,
        blockNegWeather: document.getElementById('port-block-neg-weather')?.checked || false,
        allowBvP: document.getElementById('port-allow-bvp')?.checked || false,
        stackSize: document.getElementById('port-stack-size')?.value,
        stackPct5: document.getElementById('port-stack-pct5')?.value,
        cashLine: document.getElementById('port-cash-line')?.value,
        winLine: document.getElementById('port-win-line')?.value,
        payoutType: document.getElementById('port-payout-type')?.value,
        simFilter: document.getElementById('port-sim-filter')?.checked || false,
        simFilterPct: document.getElementById('port-sim-filter-pct')?.value,
        simFilterSims: document.getElementById('port-sim-filter-sims')?.value,
        simROIMin: document.getElementById('port-sim-roi-min')?.value,
        simROIMax: document.getElementById('port-sim-roi-max')?.value,
        bbEnabled: document.getElementById('port-bb-enabled')?.checked !== false,
        bbMinOppImplied: document.getElementById('port-bb-min-implied')?.value,
        bbTarget: document.getElementById('port-bb-target')?.value,
        secondaryStack: document.getElementById('port-secondary-stack')?.value,
        maxSpPair: document.getElementById('port-max-sp-pair')?.value,
        ownLambda: document.getElementById('port-own-lambda')?.value,
        maxAvgOwn: document.getElementById('port-max-avg-own')?.value,
        customCashPct: document.getElementById('custom-cash-pct')?.value,
        customCashMult: document.getElementById('custom-cash-mult')?.value,
        customWinPct: document.getElementById('custom-win-pct')?.value,
        customWinMult: document.getElementById('custom-win-mult')?.value,
        maxGameExposure: document.getElementById('port-max-game-exposure')?.value,
        banPlayers: document.getElementById('port-ban-players')?.value,
        useBestPlays: document.getElementById('port-use-best-plays')?.checked || false,
        enforceContrarian: document.getElementById('port-enforce-contrarian')?.checked || false,
        diversityAnalysis: document.getElementById('port-diversity-analysis')?.checked || false,
        bringBackTargetPct: document.getElementById('port-bring-back-target')?.value,
      },
      projOverrides: STATE.projOverrides,
      playerExposureOverrides: STATE.playerExposureOverrides,
      teamExposureOverrides: STATE.teamExposureOverrides
    };
    localStorage.setItem(LS_KEY, JSON.stringify(session));
  } catch (e) { /* quota or private-mode error — ignore */ }
}

function restoreSession() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const session = JSON.parse(raw);

    // Restore simulator controls and sync labels/engine state.
    const sc = session.simulatorConfig || {};
    if (sc.simCount != null) {
      const el = document.getElementById('sim-count');
      if (el) el.value = sc.simCount;
    }
    if (sc.corrScale != null) {
      const el = document.getElementById('sim-corr-scale');
      if (el) {
        el.value = sc.corrScale;
        const label = document.getElementById('corr-scale-label');
        if (label) label.textContent = parseFloat(sc.corrScale).toFixed(1) + '×';
        const v = parseFloat(sc.corrScale);
        if (!Number.isNaN(v)) Engine.setCorrScale(v);
      }
    }
    if (sc.simDiversity != null) {
      const el = document.getElementById('sim-diversity');
      if (el) {
        el.value = sc.simDiversity;
        const label = document.getElementById('diversity-label');
        if (label) label.textContent = parseFloat(sc.simDiversity).toFixed(1) + '×';
        const v = parseFloat(sc.simDiversity);
        if (!Number.isNaN(v)) Engine.setSimDiversity(v);
      }
    }

    // Restore blend weights
    if (session.blendWeights) {
      STATE.blendWeights = session.blendWeights;
      // Re-render sliders if they're already on screen
      renderBlendControls();
    }

    // Restore contest size
    if (session.contestSize) STATE.contestSize = session.contestSize;

    // Restore single-lineup contest type
    if (session.contestTypeSel) { const el = document.getElementById('contest-type-sel'); if (el) el.value = session.contestTypeSel; }

    // Restore source-aware multiplier flags
    if (typeof session.sourceIncludesPark === 'boolean') STATE.sourceIncludesPark = session.sourceIncludesPark;
    if (typeof session.sourceIncludesVegas === 'boolean') STATE.sourceIncludesVegas = session.sourceIncludesVegas;

    // Restore portfolio config inputs
    const pc = session.portConfig || {};
    if (pc.numLineups) { const el = document.getElementById('port-num-lineups'); if (el) el.value = pc.numLineups; }
    if (pc.maxExposure) {
      const el = document.getElementById('port-max-exposure'); if (el) el.value = pc.maxExposure;
      const lbl = document.getElementById('exp-label'); if (lbl) lbl.textContent = pc.maxExposure + '%';
    }
    if (pc.maxPitcher) {
      const el = document.getElementById('port-max-pitcher'); if (el) el.value = pc.maxPitcher;
      const lbl = document.getElementById('pitcher-exp-label'); if (lbl) lbl.textContent = pc.maxPitcher + '%';
    }
    if (pc.contestType) { const el = document.getElementById('port-contest-type'); if (el) { el.value = pc.contestType; onContestTypeChange(); } }
    if (pc.contestSize) { const el = document.getElementById('port-contest-size'); if (el) el.value = pc.contestSize; }
    if (pc.maxOverlap != null) { const el = document.getElementById('port-max-overlap'); if (el) el.value = pc.maxOverlap; }
    if (pc.minImplied != null) { const el = document.getElementById('port-min-implied'); if (el) el.value = pc.minImplied; }
    if (pc.minGameTotal != null) { const el = document.getElementById('port-min-game-total'); if (el) el.value = pc.minGameTotal; }
    if (pc.maxOppK9 != null) { const el = document.getElementById('port-max-opp-k9'); if (el) el.value = pc.maxOppK9; }
    if (pc.blockNegWeather != null) { const el = document.getElementById('port-block-neg-weather'); if (el) el.checked = pc.blockNegWeather; }
    if (pc.allowBvP != null) { const el = document.getElementById('port-allow-bvp'); if (el) el.checked = pc.allowBvP; }
    if (pc.stackSize != null) { const el = document.getElementById('port-stack-size'); if (el) { el.value = pc.stackSize; toggleStackMix(); } }
    if (pc.stackPct5 != null) { const el = document.getElementById('port-stack-pct5'); if (el) el.value = pc.stackPct5; }
    if (pc.cashLine) { const el = document.getElementById('port-cash-line'); if (el) el.value = pc.cashLine; }
    if (pc.winLine) { const el = document.getElementById('port-win-line'); if (el) el.value = pc.winLine; }
    if (pc.simFilter != null) { const el = document.getElementById('port-sim-filter'); if (el) { el.checked = pc.simFilter; toggleSimFilter(); } }
    if (pc.simFilterPct != null) { const el = document.getElementById('port-sim-filter-pct'); if (el) el.value = Math.min(500, Math.max(10, +pc.simFilterPct || 50)); }
    if (pc.simFilterSims != null) { const el = document.getElementById('port-sim-filter-sims'); if (el) el.value = pc.simFilterSims; }
    if (pc.simROIMin != null && pc.simROIMin !== '') { const el = document.getElementById('port-sim-roi-min'); if (el) el.value = pc.simROIMin; }
    if (pc.simROIMax != null && pc.simROIMax !== '') { const el = document.getElementById('port-sim-roi-max'); if (el) el.value = pc.simROIMax; }
    if (pc.bbEnabled != null) { const el = document.getElementById('port-bb-enabled'); if (el) { el.checked = pc.bbEnabled; toggleBringBackOptions(); } }
    if (pc.bbMinOppImplied != null) { const el = document.getElementById('port-bb-min-implied'); if (el) el.value = pc.bbMinOppImplied; }
    if (pc.bbTarget != null) { const el = document.getElementById('port-bb-target'); if (el) el.value = pc.bbTarget; }
    if (pc.secondaryStack != null) { const el = document.getElementById('port-secondary-stack'); if (el) el.value = pc.secondaryStack; }
    if (pc.maxSpPair != null) { const el = document.getElementById('port-max-sp-pair'); if (el) el.value = pc.maxSpPair; }
    if (pc.ownLambda != null) {
      const el = document.getElementById('port-own-lambda'); if (el) el.value = pc.ownLambda;
      const lbl = document.getElementById('own-lambda-label'); if (lbl) lbl.textContent = (pc.ownLambda / 100).toFixed(2);
    }
    if (pc.maxAvgOwn != null) { const el = document.getElementById('port-max-avg-own'); if (el) el.value = pc.maxAvgOwn; }
    if (pc.payoutType) { const el = document.getElementById('port-payout-type'); if (el) { el.value = pc.payoutType; onPayoutTypeChange(); } }
    if (pc.customCashPct != null) { const el = document.getElementById('custom-cash-pct'); if (el) el.value = pc.customCashPct; }
    if (pc.customCashMult != null) { const el = document.getElementById('custom-cash-mult'); if (el) el.value = pc.customCashMult; }
    if (pc.customWinPct != null) { const el = document.getElementById('custom-win-pct'); if (el) el.value = pc.customWinPct; }
    if (pc.customWinMult != null) { const el = document.getElementById('custom-win-mult'); if (el) el.value = pc.customWinMult; }
    if (pc.maxGameExposure != null) { const el = document.getElementById('port-max-game-exposure'); if (el) el.value = pc.maxGameExposure; }
    if (pc.banPlayers != null) { const el = document.getElementById('port-ban-players'); if (el) el.value = pc.banPlayers; }
    if (pc.useBestPlays != null) { const el = document.getElementById('port-use-best-plays'); if (el) el.checked = pc.useBestPlays; }
    if (pc.enforceContrarian != null) { const el = document.getElementById('port-enforce-contrarian'); if (el) el.checked = pc.enforceContrarian; }
    if (pc.diversityAnalysis != null) { const el = document.getElementById('port-diversity-analysis'); if (el) el.checked = pc.diversityAnalysis; }
    if (pc.bringBackTargetPct != null) {
      const el = document.getElementById('port-bring-back-target');
      if (el) {
        el.value = pc.bringBackTargetPct;
        const lbl = document.getElementById('bb-target-label');
        if (lbl) lbl.textContent = pc.bringBackTargetPct + '%';
      }
    }

    // Restore player exposure overrides
    if (session.playerExposureOverrides) {
      STATE.playerExposureOverrides = session.playerExposureOverrides;
      renderExposureOverrides();
    }

    // Restore team exposure overrides
    if (session.teamExposureOverrides) {
      STATE.teamExposureOverrides = session.teamExposureOverrides;
      renderTeamExposureOverrides();
    }

    // Restore projection overrides (applied to pool in mergePools when pool is loaded)
    if (session.projOverrides && typeof session.projOverrides === 'object') {
      STATE.projOverrides = session.projOverrides;
    }

    // Restore lineup-builder BvP checkbox
    if (session.allowBvP != null) { const el = document.getElementById('allow-bvp'); if (el) el.checked = session.allowBvP; }

    // Run validation so any bad stored ROI band or other settings surface immediately
    validatePortfolioSettings();

    // Restore lineup slots — resolved against POOL once POOL is loaded
    if (session.lineup) {
      window._pendingLineupRestore = session.lineup;
    }
    if (session.lockedSlots) {
      window._pendingLockedSlotsRestore = session.lockedSlots;
    }
  } catch (e) { /* corrupt or old session — ignore */ }
}

// Called after POOL is populated to hydrate the saved lineup
function applyPendingLineupRestore() {
  if (!window._pendingLineupRestore || !STATE.POOL.length) return;
  const pending = window._pendingLineupRestore;
  window._pendingLineupRestore = null;
  pending.forEach((entry, i) => {
    if (!entry) return;
    const p = STATE.POOL.find(pl => pl.name === entry.name);
    if (p && !STATE.lineup[i]) STATE.lineup[i] = p;
  });
  if (window._pendingLockedSlotsRestore) {
    STATE.lockedSlots = window._pendingLockedSlotsRestore;
    window._pendingLockedSlotsRestore = null;
  }
  renderLineup();
  renderLuPool();
}

// ── Init: Load park factors on startup ────────────────────────────────────────
// ── Source Quality Display ────────────────────────────────────────────────────
async function renderSourceQuality() {
  try {
    const quality = await fetch('/api/source-quality').then(r => r.json());
    const panel = document.getElementById('source-quality-panel');
    const rows  = document.getElementById('source-quality-rows');
    const entries = Object.entries(quality);
    if (!entries.length) { panel.style.display = 'none'; return; }

    rows.innerHTML = entries.map(([fname, q]) => {
      const s = q.summary;
      if (!s) return '';
      const spearman = s.avgSpearman;
      const bias     = s.avgBias;
      // Spearman > 0.55 = good rank accuracy; < 0.35 = poor
      const sqColor  = spearman >= 0.55 ? 'var(--tsu)' : spearman >= 0.40 ? 'var(--ti)' : 'var(--td)';
      const sqLabel  = spearman >= 0.55 ? 'good' : spearman >= 0.40 ? 'fair' : 'poor';
      // Bias: how much the source over/under-projects on average
      const biasSign = bias > 0 ? '+' : '';
      const biasColor = Math.abs(bias) < 0.08 ? 'var(--tsu)' : Math.abs(bias) < 0.15 ? 'var(--tw)' : 'var(--td)';
      // Suggest adjusted weight based on Spearman (sources with higher rank accuracy get more weight)
      return `<div style="display:flex;gap:10px;align-items:center;padding:4px 0;border-bottom:0.5px solid var(--brd-s);font-size:11px">
        <span style="flex:1;color:var(--tp);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(fname)}">${esc(fname)}</span>
        <span style="color:${sqColor};font-weight:600" title="Spearman rank correlation — how well this source ranks players vs actuals">r=${spearman.toFixed(2)} (${sqLabel})</span>
        <span style="color:${biasColor}" title="Average over/under-projection relative to actuals">bias ${biasSign}${(bias * 100).toFixed(0)}%</span>
        <span style="color:var(--ts)">${s.slateCount} slate${s.slateCount !== 1 ? 's' : ''}</span>
      </div>`;
    }).join('');
    panel.style.display = entries.length ? 'block' : 'none';
  } catch (e) { /* quality data not yet available — hide panel */ }
}

// ══ BEST PLAYS ═════════════════════════════════════════════════════════════════

function renderBestPlays() {
  const panel  = document.getElementById('plays-content');
  const empty  = document.getElementById('plays-empty');
  if (!panel || !empty) return;

  const rawPool = getCalibratedPool();
  const pool = rawPool.filter(p => p.median > 0 || p.salary > 0);
  dlog('[BestPlays] calibrated pool=%d projected=%d', rawPool.length, pool.length);
  if (rawPool.length && !pool.length) console.warn('[BestPlays] All players filtered out — no median or salary data');
  if (!pool.length) {
    panel.style.display = 'none';
    empty.style.display = 'block';
    return;
  }
  panel.style.display = 'block';
  empty.style.display = 'none';

  const ctx = getEngineContext();
  const contestSize = parseInt(document.getElementById('port-contest-size')?.value) || STATE.contestSize || 1000;
  dlog('[BestPlays] hasConfirmedData=%s vegasTeams=%d contestSize=%d',
    ctx.hasConfirmedData, Object.keys(ctx.vegasData || {}).length, contestSize);
  const plays = Engine.getBestPlays(pool, ctx, contestSize);
  dlog('[BestPlays] results — SE pitchers=%d seStack=%s contrarian=%s bringBack=%s leverage=%d boomBust=%d',
    plays.singleEntry.pitchers.length,
    plays.singleEntry.stack?.team || 'NONE',
    plays.gpp.contrarianStack?.team || 'NONE',
    plays.gpp.bringBack?.team || 'NONE',
    plays.gpp.leveragePlays.length,
    plays.gpp.boomBust.length);

  // Store best plays data for lineup builder integration
  STATE.lastBestPlays = plays;
  STATE.bestPlaysContext = {
    leveragePlays: new Set(plays.gpp.leveragePlays.map(e => e.p.name)),
    chalkPlayers: new Set(plays.gpp.chalkStacks.flatMap(c => c.top5).map(e => e.p.name)),
    contrarianPlayers: new Set(plays.gpp.contrarianStack?.top5.map(e => e.p.name) || []),
    bringBackPlayers: new Set(plays.gpp.bringBack?.entries.map(e => e.p.name) || []),
    contrarianTeam: plays.gpp.contrarianStack?.team || null,
    singleEntryPitchers: new Set(plays.singleEntry.pitchers.map(e => e.p.name)),
    valuePlayNames: new Set(plays.singleEntry.valuePlays.map(e => e.p.name)),
  };

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function tagHtml(tags) {
    return (tags || []).map(t =>
      `<span class="bp-tag bp-tag-${t.type}">${esc(t.label)}</span>`
    ).join('');
  }

  function playerRow(p, opts) {
    opts = opts || {};
    const isP = Engine.rp(p, 'P');
    const pos = (p.rosterPos || p.dkPos || '').split('/')[0] || '?';
    const orderBadge = (!isP && p.order > 0)
      ? `<span class="bp-order">#${p.order}</span>` : '';
    const ownClass = (p.own || 0) < 8 ? 'bp-own-low' : (p.own || 0) > 30 ? 'bp-own-high' : '';
    const ownBadge = p.own > 0
      ? `<span class="bp-own ${ownClass}">${p.own.toFixed(0)}%</span>` : '';
    const medCeil = `<span class="bp-pts">${(p.median || 0).toFixed(1)}<span class="bp-ceil"> / ${(p.ceiling || 0).toFixed(1)}</span></span>`;
    return `<div class="bp-player-row">
      <div class="bp-player-left">
        <span class="bp-pos">${esc(pos)}</span>
        <span class="bp-name" onclick="addToLineupByName('${escAttr(p.name)}')" title="Add to lineup">${esc(p.name)}</span>
        ${orderBadge}
        <span class="bp-team">${esc(p.team)}</span>
      </div>
      <div class="bp-player-right">
        ${tagHtml(opts.tags)}
        <span class="bp-sal">$${(p.salary || 0).toLocaleString()}</span>
        ${ownBadge}
        ${medCeil}
      </div>
    </div>`;
  }

  function sectionHdr(title, sub) {
    return `<div class="bp-section-hdr">${esc(title)}${sub ? `<span class="bp-subhdr">${esc(sub)}</span>` : ''}</div>`;
  }

  // ── SINGLE ENTRY column ───────────────────────────────────────────────────────
  let seHtml = '';

  // Pitcher Picks
  if (plays.singleEntry.pitchers.length) {
    seHtml += `<div class="bp-card">
      ${sectionHdr('Pitcher Picks', 'K% · Matchup · Floor')}
      <div class="bp-card-body">
        ${plays.singleEntry.pitchers.map(({ p, tags }) => playerRow(p, { tags })).join('')}
      </div>
      <div class="bp-card-tip">Target: K% ≥ 22% · opp implied &lt; 4.0 · win prob &gt; 50%</div>
    </div>`;
  }

  // Best Hitter Stack
  const st = plays.singleEntry.stack;
  if (st) {
    const impliedTag = st.implied >= 5.0
      ? [{ label: `${st.implied.toFixed(1)} implied (elite)`, type: 'good' }]
      : st.implied >= 4.5
        ? [{ label: `${st.implied.toFixed(1)} implied`, type: 'ok' }]
        : st.implied > 0
          ? [{ label: `${st.implied.toFixed(1)} implied`, type: 'bad' }]
          : [];
    seHtml += `<div class="bp-card">
      ${sectionHdr(st.team + ' Stack', 'Order 1–5 · Floor-first')}
      <div class="bp-section-meta">${tagHtml(impliedTag)}</div>
      <div class="bp-card-body">
        ${st.entries.map(({ p }) => playerRow(p)).join('')}
      </div>
      <div class="bp-card-tip">2–3 hitters, same team, spots 1–5 · OBP + contact profile ideal</div>
    </div>`;
  }

  // Value Plays
  if (plays.singleEntry.valuePlays.length) {
    seHtml += `<div class="bp-card">
      ${sectionHdr('Value Plays', 'Median ÷ Salary')}
      <div class="bp-card-body">
        ${plays.singleEntry.valuePlays.map(({ p, value }) => {
          const tags = [{ label: `${value.toFixed(2)}× val`, type: value >= 5 ? 'good' : 'ok' }];
          return playerRow(p, { tags });
        }).join('')}
      </div>
      <div class="bp-card-tip">Salary efficiency frees cap for premium plays elsewhere</div>
    </div>`;
  }

  // ── GPP column ────────────────────────────────────────────────────────────────
  let gppHtml = '';

  // Chalk Warning
  if (plays.gpp.chalkStacks.length) {
    const chalkList = plays.gpp.chalkStacks
      .map(t => `<strong>${esc(t.team)}</strong> (${t.implied.toFixed(1)} R · ~${t.avgOwn.toFixed(0)}% avg own)`)
      .join(' &nbsp;·&nbsp; ');
    gppHtml += `<div class="bp-card bp-card-warn">
      ${sectionHdr('Chalk Warning', 'Field favorites — everyone is here')}
      <div class="bp-card-body" style="padding:4px 0">
        <div class="bp-chalk-text">Field will be heavy on ${chalkList}. In single-entry GPP, consider pivoting away — if any hitter has an off night your lineup is dead. In multi-entry, you can run them alongside contrarian builds.</div>
      </div>
    </div>`;
  }

  // Contrarian Stack
  const cs = plays.gpp.contrarianStack;
  if (cs) {
    const rankLabel = plays.gpp.contrarianRank ? `#${plays.gpp.contrarianRank} implied on slate` : '';
    const csTags = [];
    if (rankLabel) csTags.push({ label: rankLabel, type: 'ok' });
    csTags.push({ label: `~${cs.avgOwn.toFixed(0)}% avg own`, type: cs.avgOwn < 15 ? 'good' : 'ok' });
    if (cs.implied >= 5.0) csTags.push({ label: `${cs.implied.toFixed(1)} R implied`, type: 'good' });
    else if (cs.implied >= 4.5) csTags.push({ label: `${cs.implied.toFixed(1)} R implied`, type: 'ok' });
    csTags.push({ label: 'Field skews away → leverage', type: 'ok' });
    gppHtml += `<div class="bp-card bp-card-feature">
      ${sectionHdr(cs.team + ' Contrarian Stack', 'GPP Primary Stack Target')}
      <div class="bp-section-meta">${tagHtml(csTags)}</div>
      <div class="bp-card-body">
        ${cs.top5.map(({ p }) => playerRow(p)).join('')}
      </div>
      <div class="bp-card-tip">4–5 man stack · spots 1–5 · builds field uniqueness when this team erupts</div>
    </div>`;
  }

  // Bring-Back
  const bb = plays.gpp.bringBack;
  if (bb) {
    const bbTags = [
      { label: `${bb.implied.toFixed(1)} R implied`, type: bb.implied >= 4.5 ? 'good' : 'ok' },
      { label: `~${bb.avgOwn.toFixed(0)}% avg own`, type: 'ok' },
    ];
    gppHtml += `<div class="bp-card">
      ${sectionHdr(bb.team + ' Bring-Back', 'Game-Stack Correlation')}
      <div class="bp-section-meta">${tagHtml(bbTags)}</div>
      <div class="bp-card-body">
        ${bb.entries.map(({ p }) => playerRow(p)).join('')}
      </div>
      <div class="bp-card-tip">Add 2–3 from the opposing team — both offenses benefit from a high-scoring game</div>
    </div>`;
  }

  // Leverage Plays
  if (plays.gpp.leveragePlays.length) {
    gppHtml += `<div class="bp-card">
      ${sectionHdr('Top Leverage Plays', 'Ceiling ÷ Ownership')}
      <div class="bp-card-body">
        ${plays.gpp.leveragePlays.slice(0, 6).map(({ p, levScore }) => {
          const tags = [
            { label: `Lev ${levScore.toFixed(1)}`, type: levScore > 6 ? 'good' : 'ok' },
            { label: `${(p.own || 0).toFixed(0)}% own`, type: (p.own || 0) < 8 ? 'good' : 'ok' }
          ];
          return playerRow(p, { tags });
        }).join('')}
      </div>
      <div class="bp-card-tip">Low-owned plays where the ceiling justifies the risk — wins tournaments when they pop</div>
    </div>`;
  }

  // Boom/Bust
  if (plays.gpp.boomBust.length) {
    gppHtml += `<div class="bp-card">
      ${sectionHdr('Boom/Bust Candidates', 'HR Upside · &lt;12% Own')}
      <div class="bp-card-body">
        ${plays.gpp.boomBust.map(({ p, upside }) => {
          const tags = [
            { label: `${upside.toFixed(1)}× ceiling`, type: upside >= 2.5 ? 'good' : 'ok' },
            { label: `${(p.own || 0).toFixed(0)}% own`, type: 'ok' }
          ];
          return playerRow(p, { tags });
        }).join('')}
      </div>
      <div class="bp-card-tip">The one-off HR play · unique · must have power upside (ISO + launch angle)</div>
    </div>`;
  }

  panel.innerHTML = `
    <div class="bp-columns">
      <div class="bp-col">
        <div class="bp-col-hdr">
          <div class="bp-col-title">Single Entry</div>
          <div class="bp-col-sub">50/50 · H2H · Floor first</div>
        </div>
        ${seHtml || '<div class="empty" style="padding:20px 0">No projections loaded.</div>'}
      </div>
      <div class="bp-col">
        <div class="bp-col-hdr bp-col-hdr-gpp">
          <div class="bp-col-title">GPP Tournament</div>
          <div class="bp-col-sub">Large field · Leverage · Ceiling</div>
        </div>
        ${gppHtml || '<div class="empty" style="padding:20px 0">Load Vegas + ownership for GPP analysis.</div>'}
      </div>
    </div>`;
}

// ══ SLATE SUMMARY ══════════════════════════════════════════════════════════════

function renderSlateSummary() {
  const content = document.getElementById('slate-content');
  const empty = document.getElementById('slate-empty');
  if (!content || !empty) return;

  const pool = STATE.POOL.filter(p => p.median > 0 || p.salary > 0);
  dlog('[SlateSummary] pool=%d vegasTeams=%d parkFactors=%d weatherEntries=%d',
    pool.length, Object.keys(STATE.vegasData || {}).length,
    Object.keys(STATE.parkFactors || {}).length, Object.keys(STATE.weatherData || {}).length);
  if (!pool.length) {
    content.style.display = 'none';
    empty.style.display = 'block';
    return;
  }
  content.style.display = 'block';
  empty.style.display = 'none';

  // ── Build game objects ─────────────────────────────────────────────────────
  const gameKeys = [...new Set(pool.map(p => p.game).filter(Boolean))];
  const playersWithoutGame = pool.filter(p => !p.game);
  if (playersWithoutGame.length) dlog('[SlateSummary] %d players have no game field: %s', playersWithoutGame.length, playersWithoutGame.slice(0,5).map(p=>p.name).join(', '));
  const games = gameKeys.map(game => {
    const [away, home] = game.split('@');
    const homeVD = STATE.vegasData?.[home] || {};
    const awayVD = STATE.vegasData?.[away] || {};
    const homeImplied = homeVD.impliedTotal || 0;
    const awayImplied = awayVD.impliedTotal || 0;
    const ou = homeImplied + awayImplied;
    const pf = STATE.parkFactors?.[home] || { overall: 1.0, run: 1.0, hr: 1.0 };
    const isDome = STATE.stadiumData?.domes?.includes(home);
    const weather = (!isDome && STATE.weatherData?.[home] && !STATE.weatherData[home].error)
      ? STATE.weatherData[home] : null;
    const wm = weather ? Engine.weatherMultiplier(weather) : { hitting: 1.0, pitching: 1.0, label: '', risk: 'none' };
    const we = STATE.windEffects?.[home] || 0;
    const windLabel = we > 0.3 ? 'OUT' : we < -0.3 ? 'IN' : '—';
    const homeMvt = homeImplied && homeVD.openTotal ? +(homeImplied - homeVD.openTotal).toFixed(1) : 0;
    const awayMvt = awayImplied && awayVD.openTotal ? +(awayImplied - awayVD.openTotal).toFixed(1) : 0;
    const envScore = ou > 0 ? ou * (pf.overall || 1.0) * wm.hitting : 0;
    return { game, away, home, homeImplied, awayImplied, ou, pf, isDome, weather, wm, we, windLabel, homeMvt, awayMvt, envScore };
  }).sort((a, b) => b.envScore - a.envScore);

  if (_debug) {
    games.forEach(g => dlog('[SlateSummary] game %s O/U=%.1f (home %.1f / away %.1f) pf=%.3f weather=%s envScore=%.2f',
      g.game, g.ou, g.homeImplied, g.awayImplied, g.pf.overall, g.wm.label || 'none', g.envScore));
    const gamesWithoutVegas = games.filter(g => g.ou === 0);
    if (gamesWithoutVegas.length) console.warn('[SlateSummary] Games with no vegas O/U: %s', gamesWithoutVegas.map(g=>g.game).join(', '));
  }

  const gameMap = {};
  games.forEach(g => { gameMap[g.game] = g; });

  // ── Per-team batter grouping ───────────────────────────────────────────────
  const teamBatters = {};
  pool.filter(p => !rp(p, 'P') && p.median > 0).forEach(p => {
    if (!teamBatters[p.team]) teamBatters[p.team] = { team: p.team, game: p.game || '', opp: p.opp || '', players: [] };
    teamBatters[p.team].players.push(p);
  });

  // ── Stack target scores ────────────────────────────────────────────────────
  const stackTargets = Object.values(teamBatters).map(t => {
    const sorted = [...t.players].sort((a, b) => b.median - a.median);
    const top5 = sorted.slice(0, 5);
    const g = gameMap[t.game] || {};
    const implied = STATE.vegasData?.[t.team]?.impliedTotal || 0;
    const pfVal = g.pf?.overall || 1.0;
    const wHit = g.wm?.hitting || 1.0;
    const avgMed5 = top5.length ? top5.reduce((s, p) => s + p.median, 0) / top5.length : 0;
    const avgCeil5 = top5.length ? top5.reduce((s, p) => s + p.ceiling, 0) / top5.length : 0;
    const avgOwn5 = top5.length ? top5.reduce((s, p) => s + (p.own || 0), 0) / top5.length : 0;
    // Score: implied total is the dominant driver (DFS theory: team totals correlate strongest with runs)
    const score = implied * 4.0 + (pfVal - 1.0) * 20 + avgMed5 * 0.8 + (wHit - 1.0) * 50;
    return {
      team: t.team, game: t.game, opp: t.opp, implied, pf: pfVal, wHit,
      avgMed5, avgCeil5, avgOwn5, playerCount: sorted.length, top5, score,
      wRisk: g.wm?.risk || 'none', weatherLabel: g.wm?.label || '', isDome: g.isDome || false
    };
  }).filter(t => t.implied > 0 || t.avgMed5 > 3).sort((a, b) => b.score - a.score);

  dlog('[SlateSummary] stackTargets=%d top-3: %s', stackTargets.length,
    stackTargets.slice(0,3).map(t=>`${t.team} impl=${t.implied.toFixed(1)} avgMed=${t.avgMed5.toFixed(1)}`).join(' | '));
  const teamsFiltered = Object.values(teamBatters).filter(t => {
    const implied = STATE.vegasData?.[t.team]?.impliedTotal || 0;
    const avgMed5 = [...t.players].sort((a,b)=>b.median-a.median).slice(0,5).reduce((s,p)=>s+p.median,0)/Math.min(t.players.length,5)||0;
    return !(implied > 0 || avgMed5 > 3);
  });
  if (teamsFiltered.length) dlog('[SlateSummary] %d teams dropped from stack targets (no implied, avgMed ≤3): %s', teamsFiltered.length, teamsFiltered.map(t=>t.team).join(', '));

  // ── Pitcher landscape ──────────────────────────────────────────────────────
  const pitchers = pool.filter(p => rp(p, 'P')).map(p => {
    const oppImplied = STATE.vegasData?.[p.opp]?.impliedTotal || 0;
    const value = p.salary > 0 ? (p.median / p.salary * 1000) : 0;
    // Score: median matters most, then matchup quality, then value
    const matchupBonus = oppImplied > 0 ? Math.max(0, 6 - oppImplied) * 1.5 : 0;
    const score = p.median * 0.5 + matchupBonus + value * 3;
    return { ...p, oppImplied, value, score };
  }).sort((a, b) => b.score - a.score);

  // ── Ownership intelligence ─────────────────────────────────────────────────
  const ownedPool = pool.filter(p => p.own > 0);
  const chalkPlayers = ownedPool.filter(p => p.own > 25).sort((a, b) => b.own - a.own);
  const leveragePlays = pool
    .filter(p => p.own > 0 && p.own < 18 && p.ceiling > 20)
    .sort((a, b) => (b.ceiling / (b.own + 1)) - (a.ceiling / (a.own + 1)))
    .slice(0, 12);
  const fieldFavoriteCount = ownedPool.filter(p => p.own > 35).length;
  const avgOwn = ownedPool.length ? ownedPool.reduce((s, p) => s + p.own, 0) / ownedPool.length : 0;
  const ownConcentration = chalkPlayers.slice(0, 5).reduce((s, p) => s + (p.own || 0), 0);

  // ── Generate DFS theory signals ───────────────────────────────────────────
  const signals = _buildTheorySignals(games, stackTargets, pitchers, pool, leveragePlays, fieldFavoriteCount);

  // ── Render all sections ───────────────────────────────────────────────────
  _renderSlateMetrics(pool, games, pitchers, stackTargets);
  _renderTheorySignals(signals);
  _renderSlateGameTable(games);
  _renderSlateStackTable(stackTargets);
  _renderSlatePitcherTable(pitchers);
  _renderSlateOwnershipTable(chalkPlayers, leveragePlays, avgOwn, fieldFavoriteCount, ownConcentration);
}

function _buildTheorySignals(games, stackTargets, pitchers, pool, leveragePlays, fieldFavoriteCount) {
  const signals = [];

  // Best game environment for stacking
  const bestGame = games[0];
  if (bestGame && bestGame.ou > 0) {
    const leadTeam = bestGame.homeImplied >= bestGame.awayImplied ? bestGame.home : bestGame.away;
    const leadImpl = Math.max(bestGame.homeImplied, bestGame.awayImplied);
    signals.push({ level: 'success', label: 'STACK', title: 'Primary Stack Game',
      text: `${bestGame.away}@${bestGame.home} (O/U ${bestGame.ou.toFixed(1)}) is the highest-scoring environment on this slate. ${leadTeam} leads with a ${leadImpl.toFixed(1)} implied run total — build your primary 4–5 man stack here.` });
  } else if (stackTargets.length > 0) {
    const best = stackTargets[0];
    signals.push({ level: 'success', label: 'STACK', title: 'Primary Stack Target',
      text: `${best.team} ranks as the top stacking team by projection (avg top-5 median: ${best.avgMed5.toFixed(1)} pts). Load Vegas lines to refine with implied totals.` });
  }

  // Secondary stack
  if (stackTargets.length >= 2) {
    const sec = stackTargets[1];
    const secImpl = sec.implied > 0 ? ` (implied ${sec.implied.toFixed(1)})` : '';
    signals.push({ level: 'info', label: 'STACK', title: 'Secondary Stack',
      text: `${sec.team}${secImpl} is the second-ranked stacking target. DFS theory recommends a 2–3 man mini-stack from a second game to diversify your GPP portfolio from the chalk field construction.` });
  }

  // Park factor boost
  const parkBoostGame = games.find(g => (g.pf?.overall || 1) > 1.15);
  if (parkBoostGame) {
    const boost = (((parkBoostGame.pf?.overall || 1) - 1) * 100).toFixed(0);
    signals.push({ level: 'success', label: 'PARK', title: 'Hitter-Friendly Park',
      text: `${parkBoostGame.away}@${parkBoostGame.home} features a +${boost}% run park factor. The elevated environment amplifies ceiling for stacks — prioritize hitters from this game, especially in GPPs.` });
  }

  // Weather risks
  games.forEach(g => {
    const rain = g.weather?.precip_chance || 0;
    if (g.wm?.risk === 'rain' || rain >= 35) {
      signals.push({ level: 'warn', label: 'WEATHER', title: 'Postponement Risk',
        text: `${g.away}@${g.home}: ${rain}% precip chance. Rain suspensions after 5 innings score completed PAs on DK, but full postponements score nothing — monitor close to lock and consider reducing exposure.` });
    } else if (!g.isDome && (g.weather?.wind_mph || 0) >= 15) {
      const dir = g.windLabel !== '—' ? ` blowing ${g.windLabel}` : '';
      signals.push({ level: 'info', label: 'WIND', title: 'Elevated Wind',
        text: `${g.away}@${g.home}: ${g.weather.wind_mph}mph wind${dir}. High wind increases HR and variance — a GPP ceiling booster if direction-aware. Verify orientation vs. the park's dimensions.` });
    }
  });

  // Vegas line movement
  const movedGames = games.filter(g => Math.abs(g.homeMvt) >= 0.3 || Math.abs(g.awayMvt) >= 0.3);
  if (movedGames.length > 0) {
    const mg = movedGames[0];
    const homeBigger = Math.abs(mg.homeMvt) >= Math.abs(mg.awayMvt);
    const mvtTeam = homeBigger ? mg.home : mg.away;
    const mvt = homeBigger ? mg.homeMvt : mg.awayMvt;
    signals.push({ level: 'info', label: 'VEGAS', title: 'Sharp Line Movement',
      text: `${mvtTeam} implied total has moved ${mvt > 0 ? '+' : ''}${mvt.toFixed(1)} from open. Sharp money typically drives total movement — weight toward teams with positive implied movement in your GPP exposure.` });
  }

  // Chalk pitcher warning
  const chalkSP = pitchers.find(p => (p.own || 0) > 28);
  if (chalkSP) {
    const alts = pitchers.filter(p => p.name !== chalkSP.name && (p.own || 0) < 14 && p.median >= chalkSP.median * 0.65).slice(0, 2);
    const altText = alts.length ? ` Pivot options: ${alts.map(p => p.name).join(', ')}.` : '';
    signals.push({ level: 'warn', label: 'OWN', title: 'Chalk Pitcher Alert',
      text: `${chalkSP.name} is projected at ${(chalkSP.own || 0).toFixed(0)}% ownership — the dominant SP chalk. In GPPs, heavy SP chalk limits ceiling differentiation. If you roster this pitcher, ensure your batter stack is contrarian enough to separate.${altText}` });
  }

  // Ownership concentration
  if (fieldFavoriteCount >= 3) {
    signals.push({ level: 'warn', label: 'FIELD', title: 'Heavy-Chalk Slate',
      text: `${fieldFavoriteCount} players are projected above 35% ownership, creating high field duplication. DFS theory requires at least 2–3 differentiated plays to achieve unique tournament-winning lineups — target leverage spots in the table below.` });
  }

  // Top leverage play
  if (leveragePlays.length > 0) {
    const lp = leveragePlays[0];
    const pos = lp.dkPos || lp.rosterPos || '';
    signals.push({ level: 'info', label: 'EDGE', title: 'Top GPP Leverage Spot',
      text: `${lp.name} (${pos}, ${lp.team}): ${(lp.own || 0).toFixed(0)}% ownership with a ${lp.ceiling.toFixed(1)} pt ceiling — leverage ratio ${(lp.ceiling / ((lp.own || 1))).toFixed(1)}. Low-ownership + high-ceiling players like this create the +EV separation needed in large-field GPPs.` });
  }

  // Low-total games to avoid
  const lowEnvGames = games.filter(g => g.ou > 0 && g.ou < 7.0);
  if (lowEnvGames.length > 0) {
    const names = lowEnvGames.map(g => `${g.away}@${g.home} (${g.ou.toFixed(1)})`).join(', ');
    signals.push({ level: 'warn', label: 'AVOID', title: 'Low-Environment Games',
      text: `${names}: O/U under 7.0 projects fewer combined runs. These environments suppress both floor and ceiling — avoid primary stacks from these games in both cash and GPPs unless projections significantly outperform Vegas.` });
  }

  // Confirmed lineups
  const confirmedBatters = pool.filter(p => !rp(p, 'P') && p.isConfirmed && p.order > 0);
  if (confirmedBatters.length > 0) {
    const topOrder = confirmedBatters.filter(p => p.order <= 4).length;
    signals.push({ level: 'success', label: 'LINEUPS', title: 'Confirmed Batting Orders',
      text: `${confirmedBatters.length} batters have confirmed batting orders (${topOrder} in top-4 spots). Top-order hitters receive the most plate appearances and drive the highest correlation in multi-man stacks — prioritize confirmed lineup spots 1–5.` });
  }

  // Position scarcity check: SS/2B
  ['SS', '2B'].forEach(pos => {
    const elites = pool.filter(p => rp(p, pos) && p.median >= 8 && p.salary <= 4500);
    if (elites.length >= 3) {
      signals.push({ level: 'info', label: 'VALUE', title: `${pos} Value Concentration`,
        text: `${elites.length} ${pos} options projecting 8+ pts at ≤$4,500 — salary relief that can fund elite stacks. Use value at ${pos} to maximize salary spend on your primary stack and SP.` });
    }
  });

  return signals;
}

function _renderSlateMetrics(pool, games, pitchers, stackTargets) {
  const el = document.getElementById('slate-metrics');
  if (!el) return;
  const batters = pool.filter(p => !rp(p, 'P') && p.median > 0);
  const hasVegas = games.some(g => g.ou > 0);
  const topOU = games[0]?.ou || 0;
  const topImpl = hasVegas ? Math.max(0, ...games.map(g => Math.max(g.homeImplied, g.awayImplied)).filter(v => v > 0)) : 0;
  const chalkCount = pool.filter(p => p.own > 25).length;
  const rainGames = games.filter(g => (g.weather?.precip_chance || 0) >= 35).length;
  function mc(label, val, sub, color) {
    return `<div class="mc"><div class="mc-l">${label}</div><div class="mc-v" style="color:${color || 'var(--tp)'}">${esc(String(val))}</div>${sub ? `<div class="mc-s">${esc(sub)}</div>` : ''}</div>`;
  }
  const cards = [
    mc('Games', games.length || pool.filter(p => p.game).length || '—', 'on slate', 'var(--tp)'),
    mc('Batters', batters.length, `${pitchers.length} pitchers`),
    hasVegas
      ? mc('Top O/U', topOU > 0 ? topOU.toFixed(1) : '—', games[0] ? `${games[0].away}@${games[0].home}` : '', topOU >= 9 ? 'var(--tsu)' : topOU >= 7.5 ? 'var(--ti)' : 'var(--ts)')
      : mc('Vegas', 'Not loaded', 'fetch in Vegas tab', 'var(--tt)'),
    hasVegas
      ? mc('Best Implied', topImpl > 0 ? topImpl.toFixed(1) : '—', 'highest team total', topImpl >= 5.5 ? 'var(--tsu)' : topImpl >= 4.5 ? 'var(--ti)' : 'var(--ts)')
      : '',
    stackTargets.length
      ? mc('Top Stack', stackTargets[0].team, stackTargets[0].implied > 0 ? `${stackTargets[0].implied.toFixed(1)} implied` : 'by projection', 'var(--tsu)')
      : '',
    pool.some(p => p.own > 0)
      ? mc('Chalk Players', chalkCount, '>25% projected own', chalkCount > 5 ? 'var(--tw)' : 'var(--ts)')
      : '',
    rainGames > 0
      ? mc('Rain Risk', rainGames, `game${rainGames !== 1 ? 's' : ''} ≥35% precip`, 'var(--tw)')
      : '',
    pool.some(p => p.isConfirmed)
      ? mc('Confirmed', pool.filter(p => p.isConfirmed && p.order > 0).length, 'batters with orders', 'var(--tsu)')
      : '',
  ].filter(Boolean);
  el.innerHTML = cards.join('');
}

function _renderTheorySignals(signals) {
  const el = document.getElementById('slate-signals');
  if (!el) return;
  if (!signals.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--tt)">Load Vegas lines and ownership projections to generate DFS theory signals.</div>';
    return;
  }
  const lm = {
    success: { bg: 'var(--bsu)', border: 'var(--brd-su)', color: 'var(--tsu)' },
    info:    { bg: 'var(--bi)',  border: 'var(--brd-i)',  color: 'var(--ti)' },
    warn:    { bg: 'var(--bw)', border: 'var(--brd-w)', color: 'var(--tw)' },
  };
  el.innerHTML = signals.map(sig => {
    const s = lm[sig.level] || lm.info;
    return `<div style="background:${s.bg};border:0.5px solid ${s.border};border-radius:var(--rl);padding:10px 13px;margin-bottom:7px">
      <div style="display:flex;align-items:center;gap:7px;margin-bottom:4px">
        <span style="font-size:10px;font-weight:700;padding:2px 7px;background:${s.color};color:${s.bg};border-radius:4px;letter-spacing:.05em">${esc(sig.label)}</span>
        <span style="font-size:12px;font-weight:600;color:${s.color}">${esc(sig.title)}</span>
      </div>
      <div style="font-size:12px;color:var(--ts);line-height:1.55">${esc(sig.text)}</div>
    </div>`;
  }).join('');
}

function _renderSlateGameTable(games) {
  const el = document.getElementById('slate-game-table');
  if (!el) return;
  if (!games.length) { el.innerHTML = '<div style="font-size:12px;color:var(--tt)">No game data available.</div>'; return; }
  const hasVegas = games.some(g => g.ou > 0);
  const hasWeather = games.some(g => g.weather);
  function mvtBadge(mvt) {
    if (!mvt || Math.abs(mvt) < 0.1) return '';
    return ` <span style="font-size:9px;color:${mvt > 0 ? 'var(--tsu)' : 'var(--td)'}">${mvt > 0 ? '▲' : '▼'}${Math.abs(mvt).toFixed(1)}</span>`;
  }
  el.innerHTML = `<div class="tbl-wrap"><table>
    <thead><tr>
      <th>#</th><th>Game</th>
      ${hasVegas ? '<th>O/U</th><th>Away Impl</th><th>Home Impl</th>' : ''}
      <th>Park Factor</th>
      ${hasWeather ? '<th>Temp / Cond</th><th>Wind</th><th>Rain%</th>' : ''}
      <th>Env Score</th>
    </tr></thead>
    <tbody>${games.map((g, i) => {
      const rc = i === 0 ? 'var(--tsu)' : i < 3 ? 'var(--ti)' : 'var(--ts)';
      const pfVal = g.pf?.overall || 1;
      const pfClass = pfVal > 1.1 ? 'psu' : pfVal < 0.9 ? 'pd' : 'pg';
      const rain = g.weather?.precip_chance || 0;
      const rainColor = rain >= 50 ? 'var(--td)' : rain >= 30 ? 'var(--tw)' : 'var(--tsu)';
      const windClass = g.windLabel === 'OUT' ? 'psu' : g.windLabel === 'IN' ? 'pd' : 'pg';
      return `<tr>
        <td><strong style="color:${rc}">#${i+1}</strong></td>
        <td><strong>${esc(g.away)}@${esc(g.home)}</strong>${g.isDome ? ' <span class="pill pg" style="font-size:9px">Dome</span>' : ''}</td>
        ${hasVegas ? `
          <td><strong>${g.ou > 0 ? g.ou.toFixed(1) : '—'}</strong></td>
          <td>${g.awayImplied > 0 ? g.awayImplied.toFixed(1) : '—'}${mvtBadge(g.awayMvt)}</td>
          <td>${g.homeImplied > 0 ? g.homeImplied.toFixed(1) : '—'}${mvtBadge(g.homeMvt)}</td>
        ` : ''}
        <td><span class="pill ${pfClass}">${pfVal.toFixed(2)}x</span></td>
        ${hasWeather ? `
          <td>${g.isDome ? '<span class="pill pg">Dome</span>' : g.weather ? `${g.weather.temp_f}°F ${esc(g.wm?.label || '')}` : '—'}</td>
          <td><span class="pill ${windClass}" style="font-size:10px">${esc(g.windLabel)}</span></td>
          <td style="color:${rainColor}">${rain > 0 ? rain + '%' : '—'}</td>
        ` : ''}
        <td style="color:${rc};font-weight:600">${g.envScore > 0 ? g.envScore.toFixed(2) : '—'}</td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

function _renderSlateStackTable(stackTargets) {
  const el = document.getElementById('slate-stack-table');
  if (!el) return;
  if (!stackTargets.length) { el.innerHTML = '<div style="font-size:12px;color:var(--tt)">Load player projections to see stack targets.</div>'; return; }
  el.innerHTML = `<div class="tbl-wrap"><table>
    <thead><tr><th>#</th><th>Team</th><th>Opp</th><th>Implied</th><th>Park</th><th>Weather</th><th>Avg Med (5)</th><th>Avg Ceil (5)</th><th>Avg Own%</th><th>Score</th></tr></thead>
    <tbody>${stackTargets.slice(0, 14).map((t, i) => {
      const rc = i === 0 ? 'var(--tsu)' : i < 3 ? 'var(--ti)' : 'var(--ts)';
      const pfClass = t.pf > 1.1 ? 'psu' : t.pf < 0.9 ? 'pd' : 'pg';
      const wRiskColor = t.wRisk === 'rain' ? 'var(--td)' : 'var(--ts)';
      const implColor = t.implied >= 5.5 ? 'var(--tsu)' : t.implied >= 4.0 ? 'var(--ti)' : t.implied > 0 ? 'var(--ts)' : 'var(--tt)';
      const ownColor = t.avgOwn5 > 30 ? 'var(--tw)' : 'var(--ts)';
      return `<tr>
        <td><strong style="color:${rc}">#${i+1}</strong></td>
        <td><strong>${esc(t.team)}</strong></td>
        <td style="font-size:11px;color:var(--tt)">${esc(t.opp)}</td>
        <td><strong style="color:${implColor}">${t.implied > 0 ? t.implied.toFixed(1) : '—'}</strong></td>
        <td><span class="pill ${pfClass}">${t.pf.toFixed(2)}x</span></td>
        <td style="color:${wRiskColor};font-size:11px">${t.isDome ? 'Dome' : (esc(t.weatherLabel) || '—')}</td>
        <td>${t.avgMed5 > 0 ? t.avgMed5.toFixed(1) : '—'}</td>
        <td>${t.avgCeil5 > 0 ? t.avgCeil5.toFixed(1) : '—'}</td>
        <td style="color:${ownColor}">${t.avgOwn5 > 0 ? t.avgOwn5.toFixed(0) + '%' : '—'}</td>
        <td style="color:${rc};font-weight:600">${t.score.toFixed(1)}</td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

function _renderSlatePitcherTable(pitchers) {
  const el = document.getElementById('slate-pitcher-table');
  if (!el) return;
  if (!pitchers.length) { el.innerHTML = '<div style="font-size:12px;color:var(--tt)">No pitcher data available.</div>'; return; }
  el.innerHTML = `<div class="tbl-wrap"><table>
    <thead><tr><th>#</th><th>Pitcher</th><th>Team</th><th>Opp</th><th>Salary</th><th>Median</th><th>Ceiling</th><th>Opp Implied</th><th>Own%</th><th>Value</th><th>Role</th></tr></thead>
    <tbody>${pitchers.slice(0, 10).map((p, i) => {
      const rc = i === 0 ? 'var(--tsu)' : i < 3 ? 'var(--ti)' : 'var(--ts)';
      const ownColor = p.own > 25 ? 'var(--tw)' : (p.own > 0 && p.own < 12) ? 'var(--tsu)' : 'var(--ts)';
      const matchupClass = p.oppImplied > 5 ? 'pd' : p.oppImplied > 4 ? 'pw' : p.oppImplied > 0 ? 'psu' : 'pg';
      const isChalk = p.own > 25;
      const isPivot = p.own > 0 && p.own < 12;
      const roleLabel = isChalk ? 'CHALK' : isPivot ? 'PIVOT' : 'NEUTRAL';
      const roleBg = isChalk ? 'var(--bw)' : isPivot ? 'var(--bsu)' : 'var(--bs)';
      const roleColor = isChalk ? 'var(--tw)' : isPivot ? 'var(--tsu)' : 'var(--ts)';
      const valColor = p.value > 5.5 ? 'var(--tsu)' : p.value > 4.5 ? 'var(--ti)' : 'var(--ts)';
      return `<tr>
        <td><strong style="color:${rc}">#${i+1}</strong></td>
        <td><strong>${esc(p.name)}</strong></td>
        <td>${esc(p.team)}</td>
        <td>${esc(p.opp)}</td>
        <td>$${(p.salary || 0).toLocaleString()}</td>
        <td>${p.median > 0 ? p.median.toFixed(1) : '—'}</td>
        <td>${p.ceiling > 0 ? p.ceiling.toFixed(1) : '—'}</td>
        <td><span class="pill ${matchupClass}">${p.oppImplied > 0 ? p.oppImplied.toFixed(1) : '—'}</span></td>
        <td style="color:${ownColor}">${p.own > 0 ? p.own.toFixed(0) + '%' : '—'}</td>
        <td style="color:${valColor}">${p.value > 0 ? p.value.toFixed(2) : '—'}</td>
        <td><span style="background:${roleBg};color:${roleColor};padding:2px 6px;border-radius:4px;font-size:10px;font-weight:600">${roleLabel}</span></td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

function _renderSlateOwnershipTable(chalkPlayers, leveragePlays, avgOwn, fieldFavoriteCount, ownConcentration) {
  const el = document.getElementById('slate-ownership-table');
  if (!el) return;
  if (!chalkPlayers.length && !leveragePlays.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--tt)">Load ownership projections to see leverage analysis.</div>';
    return;
  }
  function playerRow(p, label, labelBg, labelColor) {
    const pos = p.dkPos || p.rosterPos || '?';
    const ownColor = p.own > 35 ? 'var(--td)' : p.own > 25 ? 'var(--tw)' : (p.own > 0 && p.own < 12) ? 'var(--tsu)' : 'var(--ts)';
    const levRatio = p.ceiling > 0 && p.own > 0 ? (p.ceiling / p.own).toFixed(1) : '—';
    return `<tr>
      <td><strong>${esc(p.name)}</strong></td>
      <td style="font-size:11px">${esc(pos)}</td>
      <td>${esc(p.team)}</td>
      <td>$${(p.salary || 0).toLocaleString()}</td>
      <td>${p.median > 0 ? p.median.toFixed(1) : '—'}</td>
      <td>${p.ceiling > 0 ? p.ceiling.toFixed(1) : '—'}</td>
      <td style="color:${ownColor};font-weight:600">${p.own > 0 ? p.own.toFixed(0) + '%' : '—'}</td>
      <td>${levRatio}</td>
      <td><span style="background:${labelBg};color:${labelColor};padding:2px 6px;border-radius:4px;font-size:10px;font-weight:600">${label}</span></td>
    </tr>`;
  }
  const chalkRows = chalkPlayers.slice(0, 8).map(p => playerRow(p, 'CHALK', 'var(--bw)', 'var(--tw)')).join('');
  const levRows = leveragePlays.slice(0, 8).map(p => playerRow(p, 'LEVERAGE', 'var(--bi)', 'var(--ti)')).join('');
  el.innerHTML = `
    <div style="margin-bottom:8px;font-size:12px;color:var(--ts)">
      <strong>${chalkPlayers.length}</strong> chalk players (&gt;25% own) &nbsp;·&nbsp;
      <strong>${fieldFavoriteCount}</strong> field favorites (&gt;35%) &nbsp;·&nbsp;
      Field avg own: <strong>${avgOwn.toFixed(1)}%</strong> &nbsp;·&nbsp;
      Top-5 chalk concentration: <strong>${ownConcentration.toFixed(0)}%</strong>
    </div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Player</th><th>Pos</th><th>Team</th><th>Salary</th><th>Median</th><th>Ceiling</th><th>Own%</th><th>Ceil/Own</th><th>Role</th></tr></thead>
      <tbody>${chalkRows}${levRows}</tbody>
    </table></div>`;
}

(async function init() {
  cacheDOM(); // Populate _EL element cache before any render call
  try {
    STATE.parkFactors = await fetch('/api/park-factors').then(r => r.json());
    STATE.stadiumData = await fetch('/api/stadiums').then(r => r.json());
    // Load saved calibration and apply to engine.
    // Auto-correct any persisted out-of-range values from before the clamp was added.
    const cal = await fetch('/api/calibration').then(r => r.json());
    const CAL_MIN = 0.80, CAL_MAX = 1.20;
    const batOob = (cal.batterScale || 1.0) < CAL_MIN || (cal.batterScale || 1.0) > CAL_MAX;
    const pitOob = (cal.pitcherScale || 1.0) < CAL_MIN || (cal.pitcherScale || 1.0) > CAL_MAX;
    if (batOob || pitOob) {
      const corrected = {
        batterScale: Math.max(CAL_MIN, Math.min(CAL_MAX, cal.batterScale || 1.0)),
        pitcherScale: Math.max(CAL_MIN, Math.min(CAL_MAX, cal.pitcherScale || 1.0)),
        positionScales: cal.positionScales || {}
      };
      // Persist the corrected values so it's fixed for future loads
      await fetch('/api/calibration', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(corrected)
      }).catch(() => {});
      Engine.setCalibration(corrected);
      setTimeout(() => showToast(
        `Saved calibration was outside safe range (batters ×${(cal.batterScale||1).toFixed(3)}, pitchers ×${(cal.pitcherScale||1).toFixed(3)}). ` +
        `Auto-corrected to ±20% limit. Re-run Analyze Projections in Backtest to recalibrate.`,
        'warn', 8000
      ), 1500);
    } else {
      Engine.setCalibration(cal);
    }
    // Load source quality on startup (only shows if data exists)
    renderSourceQuality();
  } catch (e) { /* Server may not be running during dev */ }
  restoreSession();
})();
