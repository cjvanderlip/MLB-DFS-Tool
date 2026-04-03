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
  generatedLineups: [],

  // Context data
  vegasData: null, parkFactors: null, weatherData: {}, stadiumData: null,
  contestSize: 1000,

  // Optimal lineups
  OPTIMAL_LINEUPS: [],
  optimalExposure: {}, optimalStacks: {},

  // Portfolio
  portfolioLineups: [], portfolioExposure: {},
  playerExposureOverrides: {},

  // Backtesting
  historyData: [],

  // Live data
  confirmedLineups: {},
  statcastData: {}, pitcherStatcastData: {},
  formData: {}, blendWeights: {},
  windEffects: {}, injuryData: [],
  umpireData: {}, dvpData: {},
  bullpenData: {},
  framingRawData: {}, framingMap: {},
  sprintSpeedData: {},
};

// ── Utilities ─────────────────────────────────────────────────────────────────
const n = v => parseFloat(v) || 0;
function rp(p, slot) { return Engine.rp(p, slot); }
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
function addStackPlayer(sid, pidx) { const s = [...STACKS3, ...STACKS5].find(st => st.id === sid); if (s && s.players[pidx]) addToLineupByName(s.players[pidx]); }

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
  return { vegasData: STATE.vegasData, parkFactors: STATE.parkFactors, weatherData: STATE.weatherData, stadiums: STATE.stadiumData, teamScoring: STATE.TEAM_SCORING, contestSize: STATE.contestSize, pool, optimalExposure: STATE.optimalExposure, optimalStacks: STATE.optimalStacks, umpireData: STATE.umpireData, blendWeights: STATE.blendWeights, bullpenData: STATE.bullpenData, framingMap: STATE.framingMap, sprintSpeedData: STATE.sprintSpeedData };
}

// Returns calibrated pool for optimizer calls — scoring functions score individual
// players from this pool, so calibration must be applied at the pool level
function getCalibratedPool() {
  return Engine.calibratePool(STATE.POOL);
}

// ── Tab Navigation ────────────────────────────────────────────────────────────
function showTab(t) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(tb => tb.classList.remove('active'));
  const panel = document.getElementById('panel-' + t);
  if (panel) panel.classList.add('active');
  const tabs = document.querySelectorAll('.tab');
  const map = { upload: 0, players: 1, stacks: 2, vegas: 3, lineup: 4, portfolio: 5, simulator: 6, backtest: 7 };
  if (map[t] !== undefined && tabs[map[t]]) tabs[map[t]].classList.add('active');

  // Load data for specific tabs
  if (t === 'vegas') loadVegasWeatherData();
  if (t === 'backtest') loadHistory();
  if (t === 'portfolio') renderPortfolioTeamSelectors();
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
  const hasMedian = h.some(x => x.includes('median'));
  const hasCeiling = h.some(x => x.includes('ceiling'));
  const hasPosition = h.includes('position');
  if (hasFloor && hasMedian && hasCeiling && hasPosition) return 'roo';
  if (hasFloor && hasMedian && hasCeiling) return 'roo';

  // Optimal lineups file: SP1/SP2/C/1B/2B/3B/SS/OF1/OF2/OF3 + Salary + Proj + Stack
  const hasSP1 = h.some(x => x === 'sp1');
  const hasSP2 = h.some(x => x === 'sp2');
  const hasC = h.includes('c');
  const hasOF1 = h.some(x => x === 'of1');
  const hasStack = h.includes('stack');
  const hasProj = h.some(x => x === 'proj' || x === 'projected' || x === 'projection');
  if (hasSP1 && hasSP2 && hasC && hasOF1 && (hasStack || hasProj)) return 'optimal';

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
      else showUploadWarn('unknown', file.name, res.meta.fields || []);
    }, error(err) { console.error('Parse error:', err); }
  });
}

function loadDK(data, fname) {
  STATE.DK_PLAYERS = data.map(r => {
    const dkPos = (r.Position || '').trim();
    const rosterPos = toRosterPos(dkPos);
    const name = (r.Name || '').trim();
    const id = (r.ID || '').trim();
    const nameId = (r['Name + ID'] || name + (id ? ' (' + id + ')' : '')).trim();
    const team = (r.TeamAbbrev || r.teamabbrev || '').trim();
    const gameInfo = (r['Game Info'] || '').trim();
    const gm = gameInfo.match(/^([A-Z]+)@([A-Z]+)\s*(.*)/);
    const away = gm ? gm[1] : '', home = gm ? gm[2] : '';
    const opp = team === away ? home : team === home ? away : '';
    return { name, dkId: id, nameId, dkPos, rosterPos, team, opp, salary: n(r.Salary || 0), game: gm ? away + '@' + home : '', gameTime: gm ? gm[3] : '', avgPpg: n(r.AvgPointsPerGame || 0), floor: 0, median: 0, ceiling: 0, top: 0, own: 0, lev: 0, order: 0, hand: '', gpp: 0, hasDk: true, hasRoo: false };
  }).filter(p => p.name && p.salary > 0);
  setFileStatus('dk', fname, STATE.DK_PLAYERS.length + ' players');
  document.getElementById('dk-export-btn').style.display = 'inline-block';
  STATE.MODE = 'dk';
  mergePools();
}

function nextRooSlot() {
  for (let i = 0; i < 3; i++) { if (!STATE.ROO_SOURCES[i]) return i; }
  return 0; // overwrite first if all full
}

function loadROO(data, fname, idx) {
  if (idx == null) idx = nextRooSlot();
  const parsed = data.map(r => {
    const pos = (r.Position || r.position || r.Pos || r.pos || '').trim();
    const own = n(r['Own%'] || r['own%'] || r.Own || r.own || 0);
    const ceil = n(r.Ceiling || r.ceiling || 0);
    return {
      name: (r.Player || r.player || r.Name || r.name || '').trim(),
      dkPos: pos, rosterPos: toRosterPos(pos),
      team: (r.Team || r.team || '').trim(), opp: (r.Opp || r.opp || '').trim(),
      hand: (r.Hand || r.hand || '').trim(), order: n(r.Order || r.order || 0),
      salary: n(r.Salary || r.salary || r.DK_Salary || 0),
      floor: n(r.Floor || r.floor || 0), median: n(r.Median || r.median || 0),
      ceiling: ceil, top: n(r['Top_finish'] || r.top_finish || 0),
      own, gpp: n(r['GPP%'] || r['gpp%'] || 0),
      lev: own > 0 ? (ceil / own * 10 - 10) : 0,
      dkId: '', nameId: '', avgPpg: 0, game: '', gameTime: '',
      hasDk: false, hasRoo: true
    };
  }).filter(p => p.name && (p.salary > 0 || p.median > 0));
  STATE.ROO_SOURCES[idx] = { data: parsed, fname };
  setFileStatus('roo' + (idx + 1), fname, parsed.length + ' players');
  autoBalanceWeights();
  blendROO();
  if (!STATE.DK_PLAYERS.length) STATE.MODE = 'roo';
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

  const parsed = data.map((r, i) => {
    const players = [];
    for (const col of batterCols) {
      const v = (r[col] || '').toString().trim();
      if (v && v !== 'nan' && v !== 'NaN' && v !== '') players.push(v);
    }
    const team = (r.Team || r.team || r.Team_ || r.team_ || '').toString().trim()
      || ((r.Player || r.player || '').toString().trim().match(/^([A-Z]{2,4})\b/) || [])[1] || '';
    const proj = n(r.Proj || r.proj || r.Median || r.median || r.Proj_ || r.proj_ || 0);
    const salary = n(r.Salary || r.salary || r.Salary_ || r.salary_ || 0);
    const own = n(r['Own%'] || r['own%'] || r.Own || r.own || r.Own_ || r.own_ || 0);
    const floor = n(r.Floor || r.floor || 0);
    const ceiling = n(r.Ceiling || r.ceiling || 0);
    return { id: (size === 3 ? 's3' : 's5') + i, players, size, team, proj, salary, own, floor, ceiling };
  }).filter(s => s.players.length >= 2);

  if (size === 3) { STATE.STACKS3 = parsed; setFileStatus('s3', fname, parsed.length + ' 3-man stacks'); }
  else { STATE.STACKS5 = parsed; setFileStatus('s5', fname, parsed.length + ' 5-man stacks'); }

  const allStacks = [...STACKS3, ...STACKS5];
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
    const team = (r[colMap(fields, 'names', 'team')] || r.Team || r.team || r.Names || r.names || '').trim();
    if (!team) return;
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

function applyOptimalToPool() {
  STATE.POOL.forEach(p => {
    const exp = STATE.optimalExposure[p.name];
    p.optExp = exp ? exp.pct : 0;
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
        p.floor = roo.floor; p.median = roo.median; p.ceiling = roo.ceiling;
        p.top = roo.top; p.own = roo.own; p.gpp = roo.gpp;
        p.order = roo.order; p.hand = roo.hand;
        if (!p.opp) p.opp = roo.opp;
        p.lev = Engine.calcLeverage(p, STATE.contestSize);
      }
      return p;
    });
    const matched = STATE.POOL.filter(p => p.hasRoo).length;
    const matchPct = Math.round(matched / STATE.ROO.length * 100);
    if (STATE.ROO.length > 0 && matched < STATE.ROO.length * 0.8) {
      showUploadWarn('mismatch', null, null, { matched, total: STATE.ROO.length, matchPct });
    } else { hideUploadWarn('mismatch'); }
  } else {
    STATE.POOL = STATE.ROO.map(p => ({ ...p, lev: Engine.calcLeverage(p, STATE.contestSize) }));
    hideUploadWarn('mismatch');
  }
  if (Object.keys(STATE.TEAM_SCORING).length) applyTeamScoringToPool();
  if (Object.keys(STATE.optimalExposure).length) applyOptimalToPool();
  updateUI();
  checkAllLoaded();
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
  renderPlayers(); renderLineup(); renderLuPool(); renderStacks();
  renderValueScatter();
  renderBlendControls();
  applyPendingLineupRestore();
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
  const withProj = STATE.POOL.filter(p => p.median > 0).length || STATE.ROO.length;
  const projLabel = rooCount > 1 ? rooCount + ' sources blended' : (STATE.MODE === 'dk' ? 'matched to ROO' : 'from ROO');
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
}

// ── Player Pool Rendering ─────────────────────────────────────────────────────
function setPos(p, btn) { STATE.curPos = p; STATE.playerLimit = 80; document.querySelectorAll('#pos-btns .pb').forEach(b => b.classList.remove('active')); btn.classList.add('active'); renderPlayers(); }
function setLuPos(p, btn) { STATE.luPos = p; document.querySelectorAll('#lu-pos-btns .pb').forEach(b => b.classList.remove('active')); btn.classList.add('active'); renderLuPool(); }
function setSortCol(c) { if (STATE.sortCol === c) STATE.sortDir *= -1; else { STATE.sortCol = c; STATE.sortDir = -1; } renderPlayers(); }
function showMorePlayers() { STATE.playerLimit += DISPLAY_LIMIT; renderPlayers(); }

function filterPlayers() {
  const tf = document.getElementById('team-sel').value;
  const gf = document.getElementById('game-sel').value;
  const q = (document.getElementById('search-inp').value || '').toLowerCase().trim();
  const filterConfirmed = document.getElementById('filter-confirmed')?.checked;
  const filterHideInjured = document.getElementById('filter-hide-injured')?.checked;
  return STATE.POOL.filter(p =>
    posMatchFilter(p, STATE.curPos) &&
    (tf === 'ALL' || p.team === tf) &&
    (gf === 'ALL' || !p.game || p.game === gf) &&
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

function renderPlayerRow(p, idx, maxC, usedNames) {
  const bw = Math.round(p.ceiling / maxC * 55);
  const lc = p.lev > 5 ? 'lp' : p.lev < -2 ? 'ln' : 'lz';
  const inLu = usedNames.has(p.name);
  const gppS = Engine.calcGppScore(p, STATE.contestSize);
  const platoonAdj = p.platoonAdj || 1.0;
  const platoonLabel = platoonAdj > 1.01 ? '<span class="pill psu" style="font-size:9px">+plat</span>' : platoonAdj < 0.99 ? '<span class="pill pd" style="font-size:9px">-plat</span>' : '';
  const optExpVal = p.optExp > 0 ? `<span class="pill ${p.optExp > 30 ? 'psu' : p.optExp > 10 ? 'pi' : 'pg'}">${p.optExp.toFixed(1)}%</span>` : '\u2014';
  const confirmedBadge = p.isConfirmed ? `<span class="pill psu" style="font-size:9px;margin-left:3px">${p.confirmedOrder ? '#' + p.confirmedOrder : 'SP'}</span>` : '';
  const scBadge = p.barrelRate > 0 ? `<span class="pill ${p.barrelRate >= 10 ? 'psu' : p.barrelRate >= 7 ? 'pi' : 'pg'}" style="font-size:9px;margin-left:3px">Brl:${p.barrelRate.toFixed(0)}%</span>` : '';
  const injuryBadge = p.injuryFlag ? `<span class="pill ${p.injuryType === 'IL' ? 'pd' : 'pw'}" style="font-size:9px;margin-left:3px" title="${escAttr(p.injuryDesc || '')}">${p.injuryType || 'INJ'}</span>` : '';
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
      dvpBadge = `<span class="pill ${dvpClass}" style="font-size:9px;margin-left:3px" title="vs ${p.opp} ${dvpPos} rank ${dvpEntry.rank}/${dvpEntry.totalTeams} (${dvpEntry.avgAllowed} DK avg allowed)">DvP:${dvpLabel}</span>`;
    }
  }
  return `<tr style="${inLu ? 'opacity:.38;' : ''}"><td><strong style="${formColor ? 'color:' + formColor : ''}">${esc(p.name)}</strong>${STATE.MODE === 'dk' && !p.hasRoo ? '<span style="font-size:10px;background:var(--bw);color:var(--tw);border-radius:3px;padding:1px 4px;margin-left:4px">no proj</span>' : ''}${confirmedBadge}${scBadge}${injuryBadge}${dvpBadge} ${platoonLabel}</td><td><span class="pill pi" style="font-size:10px">${esc(p.dkPos) || '\u2014'}</span></td><td>${esc(p.team)}</td><td>${p.salary > 0 ? '$' + p.salary.toLocaleString() : '\u2014'}</td><td>${p.order > 0 ? '#' + p.order : '\u2014'}</td><td>${p.floor > 0 ? p.floor.toFixed(1) : '\u2014'}</td><td>${p.median > 0 ? '<strong>' + p.median.toFixed(1) + '</strong>' : '\u2014'}</td><td>${p.ceiling > 0 ? `<div class="bar-w"><div class="bar" style="width:${bw}px"></div><span style="font-size:11px;color:var(--ts)">${p.ceiling.toFixed(1)}</span></div>` : '\u2014'}</td><td><input type="number" min="0" max="100" step="0.5" value="${p.own > 0 ? p.own.toFixed(1) : ''}" placeholder="0" title="Edit projected ownership %" style="width:50px;font-size:11px;padding:2px 4px;border:0.5px solid var(--brd-s);border-radius:4px;background:var(--bp);color:${p.own > 50 ? 'var(--td)' : p.own > 25 ? 'var(--tw)' : p.own > 10 ? 'var(--ti)' : 'var(--tp)'};text-align:center" oninput="updatePlayerOwn(${idx},this.value)"></td><td class="${lc}">${p.lev !== 0 ? (p.lev > 0 ? '+' : '') + p.lev.toFixed(1) : '\u2014'}</td><td style="color:var(--ti);font-weight:500">${gppS > 0 ? gppS.toFixed(1) : '\u2014'}</td><td>${optExpVal}</td><td>${p.avgPpg > 0 ? p.avgPpg.toFixed(1) : '\u2014'}</td><td>${kDisplay}</td><td><button class="btn" style="padding:3px 8px;font-size:11px" ${inLu ? 'disabled' : ''} onclick="addPlayerByPoolIdx(${idx})">+</button></td></tr>`;
}

function renderPlayers() {
  if (!STATE.POOL.length) return;
  const sf = document.getElementById('sort-sel').value;
  const sc = sf || STATE.sortCol;
  const data = sortPlayers(filterPlayers(), sc);
  const maxC = Math.max(...data.map(p => p.ceiling), 1);
  const usedNames = new Set(STATE.lineup.filter(Boolean).map(p => p.name));
  const displayData = data.slice(0, STATE.playerLimit);
  STATE._playerPoolCache = displayData;
  document.getElementById('player-tbody').innerHTML = displayData.map((p, idx) => renderPlayerRow(p, idx, maxC, usedNames)).join('');
  document.getElementById('player-more').style.display = data.length > STATE.playerLimit ? 'block' : 'none';
  const countEl = document.getElementById('player-count');
  if (countEl) {
    const showing = Math.min(data.length, STATE.playerLimit);
    countEl.textContent = data.length === STATE.POOL.length ? `${data.length} players` : `Showing ${showing} of ${data.length} (${STATE.POOL.length} total)`;
  }
}

// ── Stacks Rendering ──────────────────────────────────────────────────────────
function renderStacks() {
  const allStacks = [...STACKS3, ...STACKS5];
  if (!allStacks.length) return;
  const poolTeams = new Set(STATE.POOL.map(p => p.team));
  const stackTeams = [...new Set(allStacks.map(s => s.team))];
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

function renderLineup() {
  // Pre-compute BvP conflicts: pitcher opp teams → set of batter teams that conflict
  const allowBvP = document.getElementById('allow-bvp')?.checked || false;
  const bvpConflicts = new Set();
  if (!allowBvP) {
    STATE.lineup.forEach(p => {
      if (p && rp(p, 'P') && p.opp) bvpConflicts.add(p.opp);
    });
  }

  document.getElementById('lineup-slots').innerHTML = DK_SLOTS.map((slot, i) => {
    const p = STATE.lineup[i];
    if (!p) return `<div class="lu-slot"><div class="slot-pos">${slot.label}</div><div class="slot-empty">Empty</div></div>`;
    const ownDisplay = p.own > 0 ? ` \u00B7 ${p.own.toFixed(1)}% own` : '';
    const isBvP = !allowBvP && !rp(p, 'P') && bvpConflicts.has(p.team);
    const slotClass = isBvP ? 'lu-slot filled lu-slot-bvp' : 'lu-slot filled';
    const bvpBadge = isBvP ? `<span style="font-size:10px;font-weight:600;color:var(--td);margin-left:6px" title="Batter vs. Pitcher conflict — this batter faces your pitcher">BvP</span>` : '';
    return `<div class="${slotClass}"${isBvP ? ' style="border-color:var(--brd-d);background:var(--bd)"' : ''}><div class="slot-pos" style="${isBvP ? 'color:var(--td)' : ''}">${slot.label}</div><div style="flex:1"><div class="slot-name">${esc(p.name)}${bvpBadge}</div><div class="slot-info">${esc(p.dkPos || p.rosterPos)} \u00B7 ${esc(p.team)}${p.opp ? ' vs ' + esc(p.opp) : ''} \u00B7 $${p.salary.toLocaleString()}${ownDisplay}</div></div><button class="slot-rm" onclick="removeFromLineup(${i})">x</button></div>`;
  }).join('');
  const used = getSalaryUsed(), rem = CAP - used, pct = Math.min(used / CAP * 100, 100);
  document.getElementById('sal-used').textContent = '$' + used.toLocaleString();
  const re = document.getElementById('sal-remain');
  re.textContent = rem >= 0 ? '$' + rem.toLocaleString() + ' left' : 'OVER by $' + Math.abs(rem).toLocaleString();
  re.style.color = rem < 0 ? 'var(--td)' : rem < 3000 ? 'var(--tw)' : 'var(--tsu)';
  document.getElementById('sal-bar').style.width = pct + '%';
  document.getElementById('sal-bar').className = 'sal-bar' + (rem < 0 ? ' over' : rem < 5000 ? ' warn' : '');

  const playersInLineup = STATE.lineup.filter(Boolean);
  const totalMedian = playersInLineup.reduce((sum, p) => sum + (p.median || 0), 0);
  const avgOwnership = playersInLineup.reduce((sum, p) => sum + (p.own || 0), 0);
  document.getElementById('median-total').textContent = totalMedian.toFixed(1);
  document.getElementById('own-avg').textContent = avgOwnership.toFixed(1);

  const warns = [];
  if (rem < 0) warns.push('Over $50k salary cap');
  const filled = playersInLineup.length;
  if (filled > 0 && filled < ROSTER_SIZE) warns.push(`${ROSTER_SIZE - filled} slot${ROSTER_SIZE - filled > 1 ? 's' : ''} empty`);
  if (bvpConflicts.size > 0) {
    const bvpPlayers = playersInLineup.filter(p => !rp(p, 'P') && bvpConflicts.has(p.team)).map(p => p.name);
    if (bvpPlayers.length) warns.push(`BvP conflict: ${bvpPlayers.join(', ')} face your pitcher — toggle "Allow BvP" to permit`);
  }
  const wEl = document.getElementById('lineup-warns');
  wEl.style.display = warns.length ? 'block' : 'none';
  if (warns.length) { wEl.className = 'ib warn'; wEl.innerHTML = warns.map(w => w).join('<br>'); }

  // Live lineup analysis: correlation, stacks, bring-backs
  const analysisEl = document.getElementById('lineup-analysis');
  if (analysisEl && playersInLineup.length >= 4) {
    const analysis = Engine.analyzeLineup(STATE.lineup);
    if (analysis) {
      const corrColor = analysis.correlationScore >= 0.6 ? 'var(--tsu)' : analysis.correlationScore >= 0.35 ? 'var(--ti)' : 'var(--td)';
      const stackBadges = analysis.stacks.map(s =>
        `<span class="pill psu" style="font-size:10px">${esc(s.team)} ${s.count}-stack</span>`
      ).join(' ');
      const bbBadges = analysis.bringBacks.map(b =>
        `<span class="pill pi" style="font-size:10px">BB: ${esc(b.name)}</span>`
      ).join(' ');
      analysisEl.style.display = 'block';
      analysisEl.innerHTML = `<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:11px">
        <span>Corr: <strong style="color:${corrColor}">${analysis.correlationScore.toFixed(2)}</strong></span>
        <span>Ceil: <strong>${analysis.ceilingPts.toFixed(1)}</strong></span>
        <span>Floor: <strong>${analysis.floorPts.toFixed(1)}</strong></span>
        <span>Val: <strong>${analysis.salaryEfficiency}</strong>x</span>
        ${stackBadges}${bbBadges ? ' ' + bbBadges : '<span style="color:var(--tt)">no bring-back</span>'}
      </div>`;
    }
  } else if (analysisEl) {
    analysisEl.style.display = 'none';
  }

  checkPositionScarcity();
}

function renderLuPool() {
  if (!STATE.POOL.length) return;
  const usedNames = new Set(STATE.lineup.filter(Boolean).map(p => p.name));
  STATE._luPoolCache = STATE.POOL.filter(p => posMatchFilter(p, STATE.luPos)).sort((a, b) => b.median - a.median || b.avgPpg - a.avgPpg).slice(0, 100);
  document.getElementById('lu-pool-tbody').innerHTML = STATE._luPoolCache.map((p, idx) => {
    const inLu = usedNames.has(p.name);
    return `<tr style="${inLu ? 'opacity:.35;' : ''}"><td>${esc(p.name)}</td><td style="color:var(--tt);font-size:11px">${esc(p.dkPos) || '\u2014'}</td><td>${esc(p.team)}</td><td>$${p.salary.toLocaleString()}</td><td>${p.median > 0 ? p.median.toFixed(1) : '\u2014'}</td><td>${p.own > 0 ? p.own.toFixed(1) + '%' : '\u2014'}</td><td><button class="btn" style="padding:2px 7px;font-size:11px" ${inLu ? 'disabled' : ''} onclick="addPlayerByLuIdx(${idx})">+</button></td></tr>`;
  }).join('');
}

function addToLineupByName(name) { const p = STATE.POOL.find(r => r.name === name); if (p) addToLineup(p); }
function addToLineup(p) {
  if (!p) return;
  if (STATE.lineup.some(lp => lp && lp.name === p.name)) return;
  for (let i = 0; i < DK_SLOTS.length; i++) {
    if (STATE.lineup[i]) continue;
    if (!DK_SLOTS[i].eligible(p)) continue;
    if (getSalaryUsed() + p.salary > CAP) {
      const over = getSalaryUsed() + p.salary - CAP;
      showToast(`Cannot add ${esc(p.name)} — would exceed cap by $${over.toLocaleString()}`, 'warn', 3000);
      return;
    }
    STATE.lineup[i] = p; renderLineup(); renderLuPool(); saveSession(); return;
  }
}
function useStackById(id) {
  const s = [...STACKS3, ...STACKS5].find(st => st.id === id);
  if (!s) return;
  s.players.forEach(name => { const p = STATE.POOL.find(r => r.name === name); if (p) addToLineup(p); });
  showTab('lineup');
}
function removeFromLineup(i) {
  const removed = STATE.lineup[i];
  STATE.lineup[i] = null;
  renderLineup(); renderLuPool(); saveSession();
  if (removed) {
    showToast(`Removed ${esc(removed.name)}`, 'info', 3000, () => {
      STATE.lineup[i] = removed; renderLineup(); renderLuPool(); saveSession();
    });
  }
}
function clearLineup() { STATE.lineup = new Array(ROSTER_SIZE).fill(null); renderLineup(); renderLuPool(); document.getElementById('export-out').style.display = 'none'; saveSession(); }

// ── Auto-fill / Generate Lineups (using Engine) ──────────────────────────────
function autoFill() {
  clearLineup();
  const ctx = getEngineContext();
  const pool = getCalibratedPool();
  const contestType = document.getElementById('contest-type-sel')?.value || 'single';
  const allowBvP = document.getElementById('allow-bvp')?.checked || false;
  let scoreFn;
  if (contestType === 'cash') scoreFn = p => Engine.scoreCash(p, ctx);
  else if (contestType === 'gpp') scoreFn = p => Engine.scoreGpp(p, ctx);
  else scoreFn = p => Engine.scoreSingle(p, ctx);

  const stackBonusFn = contestType === 'gpp' ? lu => Engine.gppStackBonus(lu, null) : null;
  STATE.lineup = Engine.optimizeLineup(pool, scoreFn, { iterations: OPTIMIZER_ITERATIONS, stackBonusFn, allowBvP }) || new Array(ROSTER_SIZE).fill(null);
  renderLineup(); renderLuPool(); saveSession();
}

function generateThreeLineups() {
  if (!STATE.POOL.length) return;
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

function displayThreeLineups() {
  const types = [
    { name: 'CASH', lineup: STATE.generatedLineups[0], strategy: 'High Floor / Batting Order / Pitcher Matchups' },
    { name: 'SINGLE ENTRY', lineup: STATE.generatedLineups[1], strategy: 'Balanced Upside / Salary Value / Optimal Median' },
    { name: 'GPP', lineup: STATE.generatedLineups[2], strategy: 'Ceiling Chase / Stacking / Low Own / Bring-backs' }
  ];
  const html = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px">${types.map(type => {
    const lu = type.lineup;
    const filled = lu.filter(Boolean);
    const mediaScore = filled.reduce((s, p) => s + (p.median || 0), 0);
    const ceilScore = filled.reduce((s, p) => s + (p.ceiling || 0), 0);
    const salUsed = filled.reduce((s, p) => s + p.salary, 0);
    const avgOwn = filled.reduce((s, p) => s + (p.own || 0), 0);
    const analysis = Engine.analyzeLineup(lu);
    const stackInfo = analysis ? analysis.stacks.map(s => s.team + ' x' + s.count).join(', ') : '';
    const bbInfo = analysis ? analysis.bringBacks.map(b => b.team).join(', ') : '';
    return `<div style="border:0.5px solid var(--brd-t);border-radius:var(--rl);padding:12px;background:var(--bp)">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;padding-bottom:8px;border-bottom:0.5px solid var(--brd-s)">
        <div style="flex:1"><div style="font-size:13px;font-weight:500;color:var(--tp)">${type.name}</div><div style="font-size:10px;color:var(--ts)">${type.strategy}</div></div>
      </div>
      <div style="margin-bottom:8px">${lu.map((p, i) => {
        if (!p) return `<div style="padding:4px 6px;font-size:11px;color:var(--ts);background:var(--bs);border-radius:4px;margin-bottom:3px">${DK_SLOTS[i].label}: EMPTY</div>`;
        return `<div style="padding:4px 6px;font-size:11px;background:var(--bsu);border-radius:4px;margin-bottom:3px"><strong>${esc(p.name)}</strong> (${esc(p.dkPos)}) ${p.order > 0 && p.order <= 4 ? '<span style="font-size:9px;background:var(--bw);color:var(--tw);padding:1px 3px;border-radius:3px">#' + p.order + '</span>' : ''} $${p.salary.toLocaleString()} ${p.median.toFixed(1)}pts ${p.own > 0 ? p.own.toFixed(1) + '%' : ''}</div>`;
      }).join('')}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:8px;background:var(--bs);border-radius:var(--r);font-size:11px">
        <div>Salary: <strong>$${salUsed.toLocaleString()}</strong></div>
        <div>Median: <strong>${mediaScore.toFixed(1)}</strong></div>
        <div>Ceiling: <strong>${ceilScore.toFixed(1)}</strong></div>
        <div>Own: <strong>${avgOwn.toFixed(1)}%</strong></div>
      </div>
      ${stackInfo ? `<div style="margin-top:6px;padding:4px 8px;background:var(--bi);border-radius:4px;font-size:10px;color:var(--ti)">Stack: ${stackInfo}${bbInfo ? ' / Bring-back: ' + bbInfo : ''}</div>` : ''}
      ${analysis ? `<div style="margin-top:4px;font-size:10px;color:var(--tt)">Corr: ${analysis.correlationScore.toFixed(3)} / Eff: ${analysis.salaryEfficiency} pts/$k</div>` : ''}
    </div>`;
  }).join('')}</div>`;
  document.getElementById('three-lineups-display').innerHTML = html;
  document.getElementById('three-lineups-display').style.display = 'block';
  STATE.lineup = [...generatedLineups[0]];
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
  const rows = [['Slot', 'Player', 'Pos', 'Team', 'Salary', 'Median']];
  STATE.lineup.forEach((p, i) => {
    rows.push(p ? [DK_SLOTS[i].label, p.name, p.dkPos || '', p.team, '$' + p.salary, p.median > 0 ? p.median.toFixed(1) : ''] : [DK_SLOTS[i].label, 'EMPTY', '', '', '', '']);
  });
  dlFile(rows.map(r => r.map(csvQuote).join(',')).join('\n'), 'lineups.csv', 'text/csv');
}
function exportDK() {
  if (!STATE.lineup.every(Boolean)) {
    alert('Lineup has empty slots. Fill all 10 positions before exporting.');
    return;
  }
  const salary = STATE.lineup.reduce((s, p) => s + (p?.salary || 0), 0);
  if (salary > 50000) {
    alert(`Lineup is over the $50,000 salary cap ($${salary.toLocaleString()}). Please adjust before exporting.`);
    return;
  }
  const missing = STATE.lineup.filter(p => !p.dkId);
  if (missing.length) {
    alert('Missing DK IDs for: ' + missing.map(p => p.name).join(', ') + '\nUpload your DK Salaries CSV first.');
    return;
  }
  const header = DK_SLOTS.map(s => s.label).join(',');
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
  } catch (e) { console.error('Failed to load vegas/weather data:', e); }
}

function renderVegasPanel() {
  const games = [...new Set(STATE.POOL.map(p => p.game).filter(Boolean))];
  const teams = [...new Set(STATE.POOL.map(p => p.team).filter(Boolean))].sort();
  const vegasEl = document.getElementById('vegas-entries');
  if (!teams.length) {
    vegasEl.innerHTML = '<div class="empty">Load player data first to enter Vegas lines.</div>';
    return;
  }

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

  let html = '<div style="display:grid;gap:8px">';
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
    // Recalculate leverage with vegas data
    if (STATE.POOL.length) mergePools();
  }).catch(e => console.error('Save vegas failed:', e));
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

async function fetchWeather() {
  const el = document.getElementById('weather-display');
  if (!STATE.stadiumData) {
    try { STATE.stadiumData = await fetch('/api/stadiums').then(r => r.json()); } catch (e) {
      el.innerHTML = '<div class="ib warn">Failed to load stadium data. Make sure the server is running on localhost:3000.</div>';
      return;
    }
  }
  const teams = [...new Set(STATE.POOL.map(p => p.team).filter(Boolean))];
  const cities = [...new Set(teams.map(t => STATE.stadiumData.cities?.[t]).filter(Boolean))];
  if (!cities.length) {
    el.innerHTML = '<div class="ib warn">No teams found. Upload player data first (ROO or DK Salaries), then come back here to fetch weather.</div>';
    return;
  }

  const btn = document.getElementById('fetch-weather-btn');
  btn.textContent = 'Fetching...'; btn.disabled = true;

  try {
    const res = await fetch('/api/weather/batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cities })
    });
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    STATE.weatherData = await res.json();

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
  const cityToTeams = {};
  if (STATE.stadiumData?.cities) {
    Object.entries(STATE.stadiumData.cities).forEach(([team, city]) => {
      if (!cityToTeams[city]) cityToTeams[city] = [];
      cityToTeams[city].push(team);
    });
  }

  el.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px">${Object.entries(weatherData).map(([city, w]) => {
    if (w.error) return `<div class="sk-card"><strong>${esc(city)}</strong><div style="color:var(--td);font-size:11px">Error: ${esc(w.error)}</div></div>`;
    const wm = Engine.weatherMultiplier(w);
    const teams = cityToTeams[city] || [];
    const isDome = teams.some(t => domes.includes(t));
    // Find wind direction effect for home team at this city
    const homeTeam = teams.find(t => !isDome) || teams[0];
    const we = homeTeam ? (STATE.windEffects[homeTeam] ?? null) : null;
    const windDirLabel = we !== null ? (we > 0.3 ? 'Out' : we < -0.3 ? 'In' : 'Neutral') : '';
    const windDirColor = we !== null ? (we > 0.3 ? 'var(--tsu)' : we < -0.3 ? 'var(--td)' : 'var(--ts)') : 'var(--ts)';
    return `<div class="sk-card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <strong style="font-size:12px">${esc(city)}</strong>
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
      return `<tr>
        <td style="padding:4px 6px"><strong>${esc(name)}</strong></td>
        <td style="padding:4px 6px"><span class="pill pi" style="font-size:10px">${esc(pos)}</span></td>
        <td style="padding:4px 6px;text-align:center"><input type="number" min="0" max="100" step="5" value="${ov.min ?? ''}" placeholder="—" style="width:52px;font-size:11px;padding:2px 4px;border:0.5px solid var(--brd-s);border-radius:4px;background:var(--bp);color:var(--tp);text-align:center" oninput="updateExposureOverride(${JSON.stringify(name)},'min',this.value)"></td>
        <td style="padding:4px 6px;text-align:center"><input type="number" min="0" max="100" step="5" value="${ov.max ?? ''}" placeholder="—" style="width:52px;font-size:11px;padding:2px 4px;border:0.5px solid var(--brd-s);border-radius:4px;background:var(--bp);color:var(--tp);text-align:center" oninput="updateExposureOverride(${JSON.stringify(name)},'max',this.value)"></td>
        <td style="padding:4px 6px"><button class="btn" style="padding:2px 7px;font-size:10px;color:var(--td)" onclick="removeExposureOverride(${JSON.stringify(name)})">✕</button></td>
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

function validatePortfolioSettings() {
  const warningsEl = document.getElementById('port-warnings');
  const warnings = [];

  const numLineups = parseInt(document.getElementById('port-num-lineups').value) || 20;
  const pitcherMaxPct = parseInt(document.getElementById('port-max-pitcher').value) / 100 || 0.6;
  const lockedTeams = getCheckedTeams('port-lock-teams');
  const bannedTeams = getCheckedTeams('port-ban-teams');

  // Check pitcher viability: viable pitchers × maxExposurePitcher must cover 2 slots × numLineups
  const viablePitchers = STATE.POOL.filter(p => rp(p, 'P') && p.salary > 0 && (p.median > 0 || p.avgPpg > 0)).length;
  const neededPitcherAppearances = 2 * numLineups; // 2 P slots per lineup
  const maxPitcherAppearances = Math.ceil(viablePitchers * pitcherMaxPct * numLineups);
  if (viablePitchers > 0 && maxPitcherAppearances < neededPitcherAppearances) {
    warnings.push(`<strong>Pitcher exposure too low:</strong> ${viablePitchers} viable pitchers at ${Math.round(pitcherMaxPct * 100)}% max = ~${maxPitcherAppearances} total appearances, but ${neededPitcherAppearances} are needed (${numLineups} lineups × 2 P slots). Some pitchers will exceed their cap or lineups will fail. Raise pitcher exposure or reduce lineup count.`);
  }

  // Warn if a locked team has no stack in the stacks files
  lockedTeams.forEach(team => {
    const hasStack = [...STACKS3, ...STACKS5].some(s => s.team === team);
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

  if (warnings.length) {
    warningsEl.style.display = 'block';
    warningsEl.innerHTML = warnings.map(w => `<div class="ib warn" style="margin-bottom:6px">${w}</div>`).join('');
  } else {
    warningsEl.style.display = 'none';
    warningsEl.innerHTML = '';
  }
}

function generatePortfolio() {
  if (!STATE.POOL.length) return;
  const numLineups = parseInt(document.getElementById('port-num-lineups').value) || 20;
  const maxExposure = parseInt(document.getElementById('port-max-exposure').value) / 100 || 0.6;
  const maxExposurePitcher = parseInt(document.getElementById('port-max-pitcher').value) / 100 || 0.6;
  const contestType = document.getElementById('port-contest-type').value || 'gpp';
  const portContestSize = parseInt(document.getElementById('port-contest-size').value) || 1000;
  const maxOverlapVal = parseInt(document.getElementById('port-max-overlap')?.value) || 0;
  const requireBringBack = document.getElementById('port-require-bringback')?.checked || false;
  const allowBvP = document.getElementById('port-allow-bvp')?.checked || false;
  const stackPct5Raw = document.getElementById('port-stack-pct5')?.value;
  const stackPct5 = stackPct5Raw !== '' && stackPct5Raw != null ? parseInt(stackPct5Raw) : null;
  const lockedTeams = getCheckedTeams('port-lock-teams');
  const bannedTeams = getCheckedTeams('port-ban-teams');
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

  // Run validation warnings before generating
  validatePortfolioSettings();

  const btn = document.getElementById('gen-portfolio-btn');
  btn.textContent = 'Generating...'; btn.disabled = true;

  setTimeout(() => {
    const ctx = getEngineContext();
    ctx.contestSize = portContestSize;
    const result = Engine.buildPortfolio(getCalibratedPool(), {
      numLineups, maxExposure, maxExposurePitcher, contestType, contestSize: portContestSize,
      maxOverlap: maxOverlapVal,
      requireBringBack, allowBvP,
      playerOverrides, stackPct5,
      stacks3: STATE.STACKS3, stacks5: STATE.STACKS5,
      lockedTeams, bannedTeams,
      context: ctx, iterations: OPTIMIZER_ITERATIONS
    });
    STATE.portfolioLineups = result.lineups;
    STATE.portfolioExposure = result.playerExposure;
    renderPortfolioResults(result);
    btn.textContent = 'Generate Portfolio'; btn.disabled = false;
  }, 50);
}

function renderPortfolioResults(result) {
  const el = document.getElementById('portfolio-results');
  if (!result.lineups.length) {
    el.innerHTML = '<div class="ib warn">No valid lineups generated. Check your player pool and settings — pitcher exposure cap may be too low for the slate size.</div>';
    return;
  }

  const avgSalary = result.lineups.reduce((s, lu) => s + lu.reduce((ss, p) => ss + (p?.salary || 0), 0), 0) / result.lineups.length;
  const avgMedian = result.lineups.reduce((s, lu) => s + lu.reduce((ss, p) => ss + (p?.median || 0), 0), 0) / result.lineups.length;

  let html = '';

  // Post-generation warnings (virtual stacks, pitcher cap overruns)
  const postWarnings = [];
  if (result.virtualStackTeams?.length) {
    postWarnings.push(`<strong>Virtual stacks used for:</strong> ${result.virtualStackTeams.map(t => esc(t)).join(', ')} — no stacks file entry found; top batters were auto-selected.`);
  }
  if (result.pitcherWarnings?.length) {
    postWarnings.push(`<strong>Pitcher cap exceeded:</strong> ${result.pitcherWarnings.map(w => `${esc(w.name)} (${w.pct}%)`).join(', ')} — not enough viable pitchers to stay within the cap.`);
  }
  if (result.bannedTeams?.length) {
    postWarnings.push(`Banned teams excluded: <strong>${result.bannedTeams.map(esc).join(', ')}</strong>`);
  }
  if (result.lockedTeams?.length) {
    postWarnings.push(`Locked teams rotated: <strong>${result.lockedTeams.map(esc).join(', ')}</strong>`);
  }
  if (postWarnings.length) {
    html += postWarnings.map(w => `<div class="ib blue" style="margin-bottom:6px;font-size:12px">${w}</div>`).join('');
  }

  const maxOvlp = Engine.calcPortfolioOverlap(result.lineups);
  html += `<div class="mc-row">
    <div class="mc"><div class="mc-l">Lineups</div><div class="mc-v">${result.totalLineups}</div></div>
    <div class="mc"><div class="mc-l">Avg Salary</div><div class="mc-v">$${Math.round(avgSalary).toLocaleString()}</div></div>
    <div class="mc"><div class="mc-l">Avg Median</div><div class="mc-v">${avgMedian.toFixed(1)}</div></div>
    <div class="mc"><div class="mc-l">Unique Players</div><div class="mc-v">${Object.keys(result.playerExposure).length}</div></div>
    <div class="mc"><div class="mc-l">Max Overlap</div><div class="mc-v" style="color:${maxOvlp > 7 ? 'var(--tw)' : 'var(--tsu)'}">${maxOvlp}</div><div class="mc-s">players shared</div></div>
  </div>`;

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

  html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px">`;

  html += `<div><div class="sec-label">Pitcher Exposure <span style="font-weight:400;text-transform:none;letter-spacing:0;font-size:10px">(cap: ${pitcherCap}%)</span></div>
  <div style="max-height:220px;overflow-y:auto"><table><thead><tr><th>Pitcher</th><th>#</th><th>Exp%</th></tr></thead><tbody>
  ${pitcherEntries.length ? renderExposureRows(pitcherEntries, pitcherCap) : '<tr><td colspan="3" style="color:var(--tt)">No pitcher data</td></tr>'}
  </tbody></table></div></div>`;

  html += `<div><div class="sec-label">Batter Exposure <span style="font-weight:400;text-transform:none;letter-spacing:0;font-size:10px">(cap: ${batterCap}%)</span></div>
  <div style="max-height:220px;overflow-y:auto"><table><thead><tr><th>Batter</th><th>#</th><th>Exp%</th></tr></thead><tbody>
  ${batterEntries.length ? renderExposureRows(batterEntries, batterCap) : '<tr><td colspan="3" style="color:var(--tt)">No batter data</td></tr>'}
  </tbody></table></div></div>`;

  html += `</div>`;

  // Team stack exposure
  if (Object.keys(result.teamExposure).length) {
    html += `<div class="sec-label" style="margin-top:12px">Stack Exposure (3+ batters)</div>
    <div class="chips">${Object.entries(result.teamExposure).sort((a, b) => b[1] - a[1]).map(([team, count]) => {
      const isLocked = result.lockedTeams?.includes(team);
      return `<span class="chip${isLocked ? ' selected' : ''}">${esc(team)}: ${count}/${result.totalLineups} (${(count / result.totalLineups * 100).toFixed(0)}%)${isLocked ? ' 🔒' : ''}</span>`;
    }).join('')}</div>`;
  }

  // Individual lineups (collapsible)
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
      <div class="chips">${lu.map(p => p ? `<span class="chip">${esc(p.name)} (${esc(p.dkPos)})</span>` : '').join('')}</div>
    </div>`;
  });
  html += '</div>';

  html += `<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
    <button class="btn-p" onclick="exportPortfolio()">Export All Lineups CSV</button>
    <button class="btn-g" onclick="savePortfolioToHistory()">Save All to Backtest History</button>
    <button class="btn" onclick="runPortfolioSim()" id="port-sim-btn">Simulate Portfolio (Sim ROI)</button>
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
    renderPortfolioResults({ lineups: STATE.portfolioLineups, playerExposure: STATE.portfolioExposure, teamExposure: {}, totalLineups: total });
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
  btn.textContent = 'Simulating…'; btn.disabled = true;
  out.innerHTML = '<div class="ib blue" style="font-size:12px">Running 2,000 simulations per lineup against a synthetic ownership-weighted field…</div>';

  setTimeout(() => {
    const contestType = document.getElementById('port-contest-type')?.value || 'gpp';
    const manualCashLine = parseFloat(document.getElementById('port-cash-line')?.value) || null;
    const manualWinLine = parseFloat(document.getElementById('port-win-line')?.value) || null;
    const payoutType = document.getElementById('port-payout-type')?.value || 'top20';
    const pool = getCalibratedPool();
    const simResults = Engine.simulatePortfolio(STATE.portfolioLineups, pool, 2000, contestType, manualCashLine, manualWinLine, payoutType);

    if (!simResults.length) {
      out.innerHTML = '<div class="ib warn">Simulation failed — ensure players have projection data.</div>';
      btn.textContent = 'Simulate Portfolio (Sim ROI)'; btn.disabled = false;
      return;
    }

    const isCash = contestType === 'cash';
    const avgROI = simResults.reduce((s, r) => s + r.simROI, 0) / simResults.length;
    const avgCash = simResults.reduce((s, r) => s + r.cashRate, 0) / simResults.length;
    const cashLine = simResults[0].cashLine;

    let html = `<div class="ib blue" style="font-size:12px;margin-bottom:8px">
      Sim results vs. ownership-weighted field. Cash line ≈ <strong>${cashLine}</strong> pts.
      Portfolio avg cash rate: <strong>${avgCash.toFixed(1)}%</strong> · Avg Sim ROI: <strong style="color:${avgROI >= 0 ? 'var(--tsu)' : 'var(--td)'}">
      ${avgROI >= 0 ? '+' : ''}${avgROI.toFixed(1)}%</strong>
    </div>`;

    html += `<div style="overflow-x:auto"><table style="width:100%;font-size:11px">
      <thead><tr>
        <th style="text-align:left">Lineup</th>
        <th>P50</th><th>P10</th><th>P90</th>
        <th>Cash%</th>${isCash ? '' : '<th>Win%</th>'}
        <th style="font-weight:600">Sim ROI</th>
        <th>Stack</th>
      </tr></thead>
      <tbody>`;

    // Map sim results back to original lineup index
    const luIndexMap = new Map(STATE.portfolioLineups.map((lu, i) => [lu, i]));
    simResults.forEach(r => {
      const origIdx = luIndexMap.get(r.lu);
      const label = origIdx != null ? `#${origIdx + 1}` : '?';
      const roi = r.simROI;
      const roiColor = roi >= 10 ? 'var(--tsu)' : roi >= 0 ? 'var(--ti)' : 'var(--td)';
      const teamCts = {};
      r.lu.forEach(p => { if (p && !rp(p, 'P')) teamCts[p.team] = (teamCts[p.team] || 0) + 1; });
      const stackTeam = Object.entries(teamCts).sort((a, b) => b[1] - a[1])[0];
      const stackBadge = stackTeam ? `<span class="pill pi" style="font-size:9px">${esc(stackTeam[0])} ${stackTeam[1]}</span>` : '—';
      html += `<tr>
        <td><strong>${label}</strong></td>
        <td>${r.p50.toFixed(1)}</td>
        <td style="color:var(--ts)">${r.p10.toFixed(1)}</td>
        <td style="color:var(--tsu)">${r.p90.toFixed(1)}</td>
        <td>${r.cashRate}%</td>
        ${isCash ? '' : `<td>${r.winRate}%</td>`}
        <td style="font-weight:600;color:${roiColor}">${roi >= 0 ? '+' : ''}${roi}%</td>
        <td>${stackBadge}</td>
      </tr>`;
    });
    html += '</tbody></table></div>';
    out.innerHTML = html;
    btn.textContent = 'Simulate Portfolio (Sim ROI)'; btn.disabled = false;
  }, 30);
}

async function savePortfolioToHistory() {
  if (!STATE.portfolioLineups.length) return;
  const contest = document.getElementById('port-contest-type')?.value?.toUpperCase() || 'GPP';
  const slateDate = new Date().toISOString().substring(0, 10);
  const buyin = 0; // can be updated later in backtest tab

  const btn = document.querySelector('[onclick="savePortfolioToHistory()"]');
  if (btn) { btn.textContent = 'Saving...'; btn.disabled = true; }

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
          lineup: lineupSnapshot
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
  STATE.portfolioLineups.forEach((lu, idx) => {
    if (!lu.every(Boolean)) invalidLineups.push(idx + 1);
    const sal = lu.reduce((s, p) => s + (p?.salary || 0), 0);
    if (sal > 50000) overCap.push(`#${idx + 1} ($${sal.toLocaleString()})`);
  });
  if (invalidLineups.length) {
    alert(`${invalidLineups.length} lineup(s) have empty slots (lineup ${invalidLineups.slice(0,5).join(', ')}). Regenerate the portfolio.`);
    return;
  }
  if (overCap.length) {
    alert(`${overCap.length} lineup(s) exceed the $50,000 cap: ${overCap.slice(0,5).join(', ')}.`);
    return;
  }
  const allPlayers = STATE.portfolioLineups.flat().filter(Boolean);
  const missing = allPlayers.filter(p => !p.dkId);
  if (missing.length) {
    const unique = [...new Set(missing.map(p => p.name))];
    alert('Missing DK IDs for: ' + unique.slice(0, 5).join(', ') + (unique.length > 5 ? '...' : '') + '\nUpload your DK Salaries CSV first.');
    return;
  }
  const header = DK_SLOTS.map(s => s.label).join(',');
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
  const numSims = parseInt(document.getElementById('sim-count').value) || 10000;
  const btn = document.getElementById('run-sim-btn');
  btn.textContent = 'Simulating...'; btn.disabled = true;

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
    const result = Engine.simulateLineup(STATE.lineup, numSims);
    renderSimResults(result);
    btn.textContent = 'Run Simulation'; btn.disabled = false;
  }, 50);
}

function renderSimResults(result) {
  if (!result) return;
  const el = document.getElementById('sim-results');

  // Summary stats
  let html = `<div class="mc-row">
    <div class="mc"><div class="mc-l">Mean</div><div class="mc-v">${result.mean.toFixed(1)}</div></div>
    <div class="mc"><div class="mc-l">Std Dev</div><div class="mc-v">${result.std.toFixed(1)}</div></div>
    <div class="mc"><div class="mc-l">P10</div><div class="mc-v">${result.p10.toFixed(1)}</div></div>
    <div class="mc"><div class="mc-l">P50</div><div class="mc-v">${result.p50.toFixed(1)}</div></div>
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
    }
    renderBacktestPanel(history, summary);
  } catch (e) { console.error('Failed to load history:', e); }
}

function renderBacktestPanel(history, summary) {
  const summaryEl = document.getElementById('backtest-summary');
  const historyEl = document.getElementById('backtest-history');

  // Summary cards — include unique slates count
  summaryEl.innerHTML = `<div class="mc-row">
    <div class="mc"><div class="mc-l">Total Entries</div><div class="mc-v">${summary.totalEntries}</div></div>
    <div class="mc"><div class="mc-l">With Results</div><div class="mc-v">${summary.entriesWithResults}</div></div>
    <div class="mc"><div class="mc-l">Net Profit</div><div class="mc-v" style="color:${summary.netProfit >= 0 ? 'var(--tsu)' : 'var(--td)'}">$${summary.netProfit.toFixed(0)}</div></div>
    <div class="mc"><div class="mc-l">ROI</div><div class="mc-v" style="color:${summary.roi >= 0 ? 'var(--tsu)' : 'var(--td)'}">${summary.roi.toFixed(1)}%</div></div>
    <div class="mc"><div class="mc-l">Avg Projected</div><div class="mc-v">${summary.avgProjected.toFixed(1)}</div></div>
    <div class="mc"><div class="mc-l">Avg Actual</div><div class="mc-v">${summary.avgActual.toFixed(1)}</div></div>
    <div class="mc"><div class="mc-l">Proj Accuracy</div><div class="mc-v">${summary.projectionAccuracy.toFixed(1)}%</div></div>
  </div>`;

  // Save current lineup button
  const todayStr = new Date().toISOString().substring(0, 10);
  const saveHtml = `<div style="margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
    <select id="bt-contest" style="font-size:12px;padding:5px 8px;border-radius:var(--r);border:0.5px solid var(--brd-s);background:var(--bp);color:var(--tp)">
      <option value="GPP">GPP</option><option value="Cash">Cash</option><option value="Single">Single Entry</option>
    </select>
    <input type="date" id="bt-slate-date" value="${todayStr}" style="font-size:12px;padding:5px 8px;border-radius:var(--r);border:0.5px solid var(--brd-s);background:var(--bp);color:var(--tp)" title="Slate date — must match the date you use when loading actuals">
    <input type="number" id="bt-buyin" placeholder="Buy-in $" style="width:80px;font-size:12px;padding:5px 8px;border-radius:var(--r);border:0.5px solid var(--brd-s);background:var(--bp);color:var(--tp)">
    <button class="btn-g" onclick="saveLineupToHistory()">Save Current Lineup</button>
  </div>`;

  // History list
  let histHtml = '';
  if (history.length) {
    histHtml = `<div style="max-height:500px;overflow-y:auto"><table><thead><tr><th>Date</th><th>Contest</th><th>Proj</th><th>Actual</th><th>Accuracy</th><th>Buy-in</th><th>Won</th><th>ROI</th><th></th></tr></thead><tbody>
    ${history.slice(0, 50).map(h => {
      const roi = h.buyin && h.winnings !== null ? ((h.winnings - h.buyin) / h.buyin * 100).toFixed(0) + '%' : '\u2014';
      const roiColor = h.winnings > h.buyin ? 'var(--tsu)' : h.winnings < h.buyin ? 'var(--td)' : 'var(--ts)';
      const accuracy = h.actualPts && h.projectedPts ? (h.actualPts / h.projectedPts * 100).toFixed(0) + '%' : '\u2014';
      const accColor = h.actualPts && h.projectedPts ? (h.actualPts >= h.projectedPts * 0.95 ? 'var(--tsu)' : h.actualPts >= h.projectedPts * 0.80 ? 'var(--tw)' : 'var(--td)') : 'var(--ts)';
      const hasPlayerActuals = h.playerActuals && Object.keys(h.playerActuals).length > 0;
      const playerActualsBadge = hasPlayerActuals ? `<span class="pill psu" style="font-size:9px;margin-left:4px" title="${Object.keys(h.playerActuals).length} player scores loaded">✓ ${Object.keys(h.playerActuals).length}p</span>` : '';
      const displayDate = h.slateDate || new Date(h.date).toLocaleDateString();
      return `<tr>
        <td style="font-size:11px">${esc(displayDate)}${playerActualsBadge}</td>
        <td><span class="pill pg">${esc(h.contest)}</span></td>
        <td>${h.projectedPts?.toFixed(1) || '\u2014'}</td>
        <td><input type="number" step="0.1" value="${h.actualPts || ''}" placeholder="\u2014" style="width:60px;font-size:11px;padding:2px 4px;border-radius:4px;border:0.5px solid var(--brd-s);background:var(--bp);color:var(--tp)" onchange="updateHistoryField('${h.id}','actualPts',this.value)"></td>
        <td style="color:${accColor};font-size:11px">${accuracy}</td>
        <td>$${h.buyin || 0}</td>
        <td><input type="number" step="0.01" value="${h.winnings || ''}" placeholder="\u2014" style="width:70px;font-size:11px;padding:2px 4px;border-radius:4px;border:0.5px solid var(--brd-s);background:var(--bp);color:var(--tp)" onchange="updateHistoryField('${h.id}','winnings',this.value)"></td>
        <td style="color:${roiColor};font-weight:500">${roi}</td>
        <td><button class="btn" style="padding:2px 6px;font-size:10px;color:var(--td)" onclick="deleteHistoryEntry('${h.id}')">x</button></td>
      </tr>`;
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

  historyEl.innerHTML = saveHtml + histHtml + mgmtHtml;
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
  const projectedPts = players.reduce((s, p) => s + (p.median || 0), 0);
  const projectedOwn = players.reduce((s, p) => s + (p.own || 0), 0);
  const salary = players.reduce((s, p) => s + p.salary, 0);
  const slateDate = document.getElementById('bt-slate-date')?.value || deriveSlateDate();

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

  try {
    await fetch('/api/history', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contest, buyin, projectedPts, projectedOwn, salary, slateDate,
        lineup: lineupSnapshot,
        poolSnapshot
      })
    });
    loadHistory();
  } catch (e) { console.error('Save history failed:', e); }
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
  } catch (e) { console.error('Update history failed:', e); }
}

async function deleteHistoryEntry(id) {
  try {
    await fetch('/api/history/' + id, { method: 'DELETE' });
    loadHistory();
  } catch (e) { console.error('Delete history failed:', e); }
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
    if (data.updated > 0) {
      statusEl.innerHTML = `<div class="ib success">${data.updated} lineup(s) updated — ${data.playerCount} players matched for ${dateStr}.</div>`;
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
  const el = document.getElementById('model-analysis');
  if (!data.sufficient) {
    el.innerHTML = `<div class="ib blue" style="font-size:12px">${esc(data.message || 'Not enough data yet.')}<br>Apply actuals for completed slates using the "Load Actuals" section above.</div>`;
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
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px">
        <div><strong>Pitchers</strong> (${p?.count ?? 0} samples)<br>${biasLabel(p?.bias)}</div>
        <div><strong>Batters</strong> (${b?.count ?? 0} samples)<br>${biasLabel(b?.bias)}</div>
        ${data.topOrder?.count ? `<div><strong>Top of Order (1-3)</strong> (${data.topOrder.count})<br>${biasLabel(data.topOrder.bias)}</div>` : ''}
        ${data.highOwnership?.count ? `<div><strong>High Ownership (>25%)</strong> (${data.highOwnership.count})<br>${biasLabel(data.highOwnership.bias)}</div>` : ''}
      </div>
    </div>

    <div class="sec-label">Calibration Factors</div>
    <div style="background:var(--bs);border-radius:var(--r);padding:12px;margin-bottom:10px;font-size:12px">
      <div style="margin-bottom:6px">Pitcher projections × <strong>${data.suggestion.pitcherCalibration?.toFixed(3)}</strong>
        ${Math.abs((data.suggestion.pitcherCalibration ?? 1) - 1) < 0.015 ? ' — already accurate' : data.suggestion.pitcherCalibration < 1 ? ' — will reduce over-inflated pitcher projections' : ' — will increase under-estimated pitcher projections'}</div>
      <div>Batter projections × <strong>${data.suggestion.batterCalibration?.toFixed(3)}</strong>
        ${Math.abs((data.suggestion.batterCalibration ?? 1) - 1) < 0.015 ? ' — already accurate' : data.suggestion.batterCalibration < 1 ? ' — will reduce over-inflated batter projections' : ' — will increase under-estimated batter projections'}</div>
    </div>

    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <button class="btn-g" onclick="applyCalibration(${data.suggestion.pitcherCalibration ?? 1}, ${data.suggestion.batterCalibration ?? 1})">Apply Calibration</button>
      <button class="btn" onclick="resetCalibration()">Reset to Default</button>
      <span id="cal-status" style="font-size:11px;color:var(--ts)"></span>
    </div>
    <div id="active-calibration" style="margin-top:8px;font-size:11px;color:var(--tt)"></div>
  `;
  renderActiveCalibration();
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

  setTimeout(() => {
    // Build a pool from each entry's lineup + playerActuals for field simulation
    const flashResults = eligible.map(h => {
      // Reconstruct a pool-like array from the lineup snapshot with actual scores as "median"
      const pool = (h.lineup || []).map(p => ({
        ...p, median: h.playerActuals?.[p.name] ?? p.median ?? 0,
        floor: p.floor || 0, ceiling: p.ceiling || (p.median * 1.8) || 0,
        own: p.own || 0, salary: p.salary || 3000,
        rosterPos: p.pos || p.rosterPos || 'OF'
      })).filter(p => p.median > 0);
      if (pool.length < 5) return null;

      // Build a lightweight "lineup array" aligned to DK_SLOTS
      const fullLineup = pool.slice(0, 10);
      while (fullLineup.length < 10) fullLineup.push(fullLineup[0]);

      const isCash = (h.contest || '').toUpperCase() === 'CASH';
      const contestType = isCash ? 'cash' : 'gpp';

      // Run 500 sim portfolio (single lineup)
      const simResults = Engine.simulatePortfolio([fullLineup], pool, 500, contestType);
      if (!simResults.length) return null;
      const sr = simResults[0];

      return {
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
      };
    }).filter(Boolean);

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
      <div class="mc"><div class="mc-l">Avg Sim ROI</div><div class="mc-v" style="color:${avgSimROI >= 0 ? 'var(--tsu)' : 'var(--td)'}">
        ${avgSimROI >= 0 ? '+' : ''}${avgSimROI.toFixed(1)}%</div><div class="mc-s">vs. ownership field</div></div>
      <div class="mc"><div class="mc-l">Avg Cash Rate</div><div class="mc-v">${avgCashRate.toFixed(1)}%</div></div>
      ${avgActualROI != null ? `<div class="mc"><div class="mc-l">Actual ROI</div><div class="mc-v" style="color:${avgActualROI >= 0 ? 'var(--tsu)' : 'var(--td)'}">
        ${avgActualROI >= 0 ? '+' : ''}${avgActualROI.toFixed(1)}%</div><div class="mc-s">${withActualROI.length} entries w/ results</div></div>` : ''}
    </div>`;

    html += `<div style="overflow-x:auto;margin-top:8px"><table style="font-size:11px;width:100%">
      <thead><tr>
        <th style="text-align:left">Date</th><th>Contest</th><th>P50</th>
        <th>Cash%</th><th>Sim ROI</th>
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

async function applyCalibration(pitcherScale, batterScale) {
  try {
    await fetch('/api/calibration', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pitcherScale, batterScale })
    });
    Engine.setCalibration({ pitcherScale, batterScale });
    const st = document.getElementById('cal-status');
    if (st) { st.textContent = 'Calibration applied — optimizer will use adjusted projections.'; st.style.color = 'var(--tsu)'; }
    renderActiveCalibration();
  } catch (e) { console.error('Apply calibration failed:', e); }
}

async function resetCalibration() {
  try {
    await fetch('/api/calibration', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pitcherScale: 1.0, batterScale: 1.0 })
    });
    Engine.setCalibration({ pitcherScale: 1.0, batterScale: 1.0 });
    const st = document.getElementById('cal-status');
    if (st) { st.textContent = 'Calibration reset to default (no adjustment).'; st.style.color = 'var(--ts)'; }
    renderActiveCalibration();
  } catch (e) { console.error('Reset calibration failed:', e); }
}

function renderActiveCalibration() {
  const cal = Engine.getCalibration();
  const el = document.getElementById('active-calibration');
  if (!el) return;
  if (cal.pitcherScale === 1.0 && cal.batterScale === 1.0) {
    el.textContent = 'No calibration active — using raw projections.';
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
    const confirmedCount = Object.values(STATE.confirmedLineups).filter(g => g.confirmed).length;
    const totalGames = data.games?.length || 0;
    if (el) el.innerHTML = `<div class="ib success">${confirmedCount}/${totalGames} batting orders confirmed. ${totalGames - confirmedCount} pending (pre-game).</div>`;
    if (btn) { btn.textContent = 'Refresh Lineups'; btn.disabled = false; }
    renderPlayers();
  } catch (e) {
    if (el) el.innerHTML = `<div class="ib warn">Failed: ${esc(e.message)}</div>`;
    if (btn) { btn.textContent = 'Fetch Lineups'; btn.disabled = false; }
  }
}

function applyConfirmedToPool() {
  if (!Object.keys(STATE.confirmedLineups).length) return;
  const orderMap = {};
  const confirmedNames = new Set();
  Object.values(STATE.confirmedLineups).forEach(g => {
    const processOrder = (teamAbbr, orderArr) => {
      orderArr.forEach((name, i) => {
        const key = name.toLowerCase().replace(/[^a-z ]/g, '').trim();
        orderMap[key] = i + 1;
        confirmedNames.add(key);
      });
    };
    if (g.homeOrder?.length) processOrder(g.homeTeam, g.homeOrder);
    if (g.awayOrder?.length) processOrder(g.awayTeam, g.awayOrder);
  });

  const probablePitchers = new Set();
  Object.values(STATE.confirmedLineups).forEach(g => {
    if (g.homeProbable) probablePitchers.add(g.homeProbable.toLowerCase().replace(/[^a-z ]/g, '').trim());
    if (g.awayProbable) probablePitchers.add(g.awayProbable.toLowerCase().replace(/[^a-z ]/g, '').trim());
  });

  STATE.POOL.forEach(p => {
    const key = p.name.toLowerCase().replace(/[^a-z ]/g, '').trim();
    if (confirmedNames.has(key) && orderMap[key]) {
      p.confirmedOrder = orderMap[key];
      p.isConfirmed = true;
      if (p.order === 0 || !p.order) p.order = orderMap[key];
    } else if (rp(p, 'P') && probablePitchers.has(key)) {
      p.isConfirmed = true;
    }
  });
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
    if (status) status.innerHTML = `<span class="pill ${injuryData.length ? 'pw' : 'pg'}">${injuryData.length} flags: ${il} IL, ${gtd} GTD (last 48h)${noteText}</span>`;
  } catch (e) {
    if (status) status.innerHTML = `<span class="pill pd">Injury fetch failed: ${esc(e.message)}</span>`;
  } finally {
    if (btn) { btn.textContent = 'Fetch Injuries'; btn.disabled = false; }
  }
}

function applyInjuriesToPool() {
  const flagMap = {};
  STATE.injuryData.forEach(f => { flagMap[f.name.toLowerCase()] = f; });
  STATE.POOL.forEach(p => {
    const key = p.name.toLowerCase();
    const match = flagMap[key] || Object.keys(flagMap).find(k => key.includes(k) || k.includes(key));
    const flag = match ? (flagMap[match] || flagMap[key]) : null;
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
    const city = STATE.stadiumData.cities?.[team];
    if (!city || !STATE.weatherData[city]) continue;
    const w = STATE.weatherData[city];
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
    const city = STATE.stadiumData?.cities?.[home];
    const isDome = STATE.stadiumData?.domes?.includes(home);
    const weather = city && STATE.weatherData?.[city] && !STATE.weatherData[city].error ? STATE.weatherData[city] : null;
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
}

// ── Value Scatter Plot (SVG) ───────────────────────────────────────────────────
function renderValueScatter() {
  const el = document.getElementById('value-scatter');
  if (!el || !STATE.POOL.length) return;
  const W = Math.min(el.offsetWidth || 500, 600), H = 280;
  const PAD = { left: 40, right: 20, top: 15, bottom: 35 };
  const data = STATE.POOL.filter(p => p.salary > 0 && p.median > 0);
  if (data.length < 5) { el.innerHTML = '<div class="empty" style="padding:20px">Need salary + projection data for scatter.</div>'; return; }

  const minSal = Math.min(...data.map(p => p.salary));
  const maxSal = Math.max(...data.map(p => p.salary));
  const maxMed = Math.max(...data.map(p => p.median));
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
function renderBlendControls() {
  const el = document.getElementById('blend-controls');
  if (!el) return;

  const sources = [];
  if (STATE.ROO.length) sources.push({ name: 'ROO', count: STATE.ROO.length });
  if (STATE.statcastData && Object.keys(STATE.statcastData).length) sources.push({ name: 'Statcast', count: Object.keys(STATE.statcastData).length });
  if (STATE.formData && Object.keys(STATE.formData).length) sources.push({ name: 'Form (14d)', count: Object.keys(STATE.formData).length });

  if (sources.length < 2) {
    el.innerHTML = `<span style="font-size:11px;color:var(--tt)">
      ${STATE.ROO.length ? 'Load Statcast or 14-Day Form data above to enable blending.' : 'Upload a ROO projection file to begin.'}
    </span>`;
    return;
  }

  el.innerHTML = `<div style="font-size:11px;color:var(--ts);margin-bottom:6px">Active data sources — adjust projection scoring weights:</div>
  <div style="display:flex;flex-wrap:wrap;gap:12px">
    ${sources.map(s => {
      const wKey = 'blend-' + s.name.replace(/\W/g, '');
      const current = STATE.blendWeights[s.name] ?? 100;
      return `<div style="display:flex;flex-direction:column;gap:3px;min-width:120px">
        <label style="font-size:11px;color:var(--tt)">${esc(s.name)} <span style="color:var(--ts)">(${s.count})</span></label>
        <div style="display:flex;align-items:center;gap:6px">
          <input type="range" id="${wKey}" min="0" max="100" value="${current}" style="flex:1"
            oninput="blendWeights['${esc(s.name)}']=parseInt(this.value);document.getElementById('${wKey}-lbl').textContent=this.value+'%';saveSession()">
          <span id="${wKey}-lbl" style="font-size:11px;color:var(--ts);width:32px">${current}%</span>
        </div>
      </div>`;
    }).join('')}
  </div>
  <div style="font-size:10px;color:var(--tt);margin-top:6px">Weights adjust the scoring multipliers in optimizer. Re-run Auto-fill or Generate to apply.</div>`;
}

// ── Pool CSV Export ───────────────────────────────────────────────────────────
function exportPool() {
  if (!STATE.POOL.length) return;
  const headers = [
    'Name','Pos','Team','Opp','Game','Salary','BatOrder',
    'Floor','Median','Ceiling','Own%','Leverage','GPPScore','OptExp%','AvgPPG',
    'BarrelRate','HardHit%','xwOBA','RecentAvgDK','RecentGames','KRate',
    'IsConfirmed','ConfirmedOrder','InjuryType','InjuryDesc','PlatoonAdj'
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
    p.injuryDesc || '',
    p.platoonAdj != null ? p.platoonAdj.toFixed(3) : ''
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
      lineup: STATE.lineup.map(p => p ? { name: p.name } : null),
      allowBvP: document.getElementById('allow-bvp')?.checked || false,
      portConfig: {
        numLineups: document.getElementById('port-num-lineups')?.value,
        maxExposure: document.getElementById('port-max-exposure')?.value,
        maxPitcher: document.getElementById('port-max-pitcher')?.value,
        contestType: document.getElementById('port-contest-type')?.value,
        contestSize: document.getElementById('port-contest-size')?.value,
        maxOverlap: document.getElementById('port-max-overlap')?.value,
        requireBringBack: document.getElementById('port-require-bringback')?.checked,
        allowBvP: document.getElementById('port-allow-bvp')?.checked || false,
        stackPct5: document.getElementById('port-stack-pct5')?.value,
        cashLine: document.getElementById('port-cash-line')?.value,
        winLine: document.getElementById('port-win-line')?.value,
        payoutType: document.getElementById('port-payout-type')?.value,
      },
      playerExposureOverrides: STATE.playerExposureOverrides
    };
    localStorage.setItem(LS_KEY, JSON.stringify(session));
  } catch (e) { /* quota or private-mode error — ignore */ }
}

function restoreSession() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const session = JSON.parse(raw);

    // Restore blend weights
    if (session.blendWeights) {
      STATE.blendWeights = session.blendWeights;
      // Re-render sliders if they're already on screen
      renderBlendControls();
    }

    // Restore contest size
    if (session.contestSize) STATE.contestSize = session.contestSize;

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
    if (pc.contestType) { const el = document.getElementById('port-contest-type'); if (el) el.value = pc.contestType; }
    if (pc.contestSize) { const el = document.getElementById('port-contest-size'); if (el) el.value = pc.contestSize; }
    if (pc.maxOverlap != null) { const el = document.getElementById('port-max-overlap'); if (el) el.value = pc.maxOverlap; }
    if (pc.requireBringBack != null) { const el = document.getElementById('port-require-bringback'); if (el) el.checked = pc.requireBringBack; }
    if (pc.allowBvP != null) { const el = document.getElementById('port-allow-bvp'); if (el) el.checked = pc.allowBvP; }
    if (pc.stackPct5 != null) { const el = document.getElementById('port-stack-pct5'); if (el) el.value = pc.stackPct5; }
    if (pc.cashLine) { const el = document.getElementById('port-cash-line'); if (el) el.value = pc.cashLine; }
    if (pc.winLine) { const el = document.getElementById('port-win-line'); if (el) el.value = pc.winLine; }
    if (pc.payoutType) { const el = document.getElementById('port-payout-type'); if (el) el.value = pc.payoutType; }

    // Restore player exposure overrides
    if (session.playerExposureOverrides) {
      STATE.playerExposureOverrides = session.playerExposureOverrides;
      renderExposureOverrides();
    }

    // Restore lineup-builder BvP checkbox
    if (session.allowBvP != null) { const el = document.getElementById('allow-bvp'); if (el) el.checked = session.allowBvP; }

    // Restore lineup slots — resolved against POOL once POOL is loaded
    if (session.lineup) {
      window._pendingLineupRestore = session.lineup;
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
  renderLineup();
  renderLuPool();
}

// ── Init: Load park factors on startup ────────────────────────────────────────
(async function init() {
  try {
    STATE.parkFactors = await fetch('/api/park-factors').then(r => r.json());
    STATE.stadiumData = await fetch('/api/stadiums').then(r => r.json());
    // Load saved calibration and apply to engine
    const cal = await fetch('/api/calibration').then(r => r.json());
    Engine.setCalibration(cal);
  } catch (e) { /* Server may not be running during dev */ }
  restoreSession();
})();
