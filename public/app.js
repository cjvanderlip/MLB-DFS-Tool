// ═══════════════════════════════════════════════════════════════════════════════
// MLB DFS Tool v2.0 — Application UI Layer
// Connects Engine.js analytics to the user interface
// ═══════════════════════════════════════════════════════════════════════════════

// ── State ─────────────────────────────────────────────────────────────────────
let ROO = [], STACKS3 = [], STACKS5 = [], DK_PLAYERS = [], POOL = [], TEAM_SCORING = {};
let curPos = 'ALL', luPos = 'ALL', sortCol = 'median', sortDir = -1, playerLimit = 80;
let MODE = 'roo';
const SALARY_CAP = 50000, CAP = SALARY_CAP, ROSTER_SIZE = 10;
const DISPLAY_LIMIT = 80, MIN_SALARY_PER_SLOT = 3000, OPTIMIZER_ITERATIONS = 5000;
let _playerPoolCache = [], _luPoolCache = [];
const DK_SLOTS = Engine.DK_SLOTS;
let lineup = new Array(10).fill(null);
let generatedLineups = [];

// Context data for engine scoring
let vegasData = null, parkFactors = null, weatherData = {}, stadiumData = null;
let contestSize = 1000;

// Optimal lineups data (parsed from optimizer CSV)
let OPTIMAL_LINEUPS = [];
let optimalExposure = {};  // { playerName: { count, pct } }
let optimalStacks = {};    // { teamName: { primary: count, secondary: count, totalPct } }

// Portfolio state
let portfolioLineups = [], portfolioExposure = {};

// Backtesting state
let historyData = [];

// New feature state
let confirmedLineups = {};  // { gamePk: { homeOrder, awayOrder, ... } }
let statcastData = {};      // { normalizedName: { barrelRate, hardHitRate, xwOBA, ... } }
let formData = {};          // { normalizedName: { avgDK, ba, ... } }
let blendWeights = {};      // { sourceName: weight }
let windEffects = {};       // { homeTeam: windEffect (-1 to +1) }

// ── Utilities ─────────────────────────────────────────────────────────────────
const n = v => parseFloat(v) || 0;
function rp(p, slot) { return Engine.rp(p, slot); }
function posMatchFilter(p, f) { if (f === 'ALL') return true; if (f === 'SP') return rp(p, 'P'); return rp(p, f); }
function toRosterPos(dkPos) {
  return dkPos.split('/').map(x => { const t = x.trim(); return (t === 'SP' || t === 'RP') ? 'P' : t; }).join('/');
}
function esc(s) { const d = document.createElement('div'); d.textContent = String(s || ''); return d.innerHTML; }
function escAttr(s) { return String(s || '').replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
const debouncedRenderPlayers = debounce(() => renderPlayers(), 150);
function addPlayerByPoolIdx(idx) { const p = _playerPoolCache[idx]; if (p) addToLineup(p); }
function addPlayerByLuIdx(idx) { const p = _luPoolCache[idx]; if (p) addToLineup(p); }
function addStackPlayer(sid, pidx) { const s = [...STACKS3, ...STACKS5].find(st => st.id === sid); if (s && s.players[pidx]) addToLineupByName(s.players[pidx]); }

function getPitcherMatchupBonus(pitcher) {
  if (!rp(pitcher, 'P') || !pitcher.opp) return 0;
  const oppBatters = POOL.filter(p => p.team === pitcher.opp && !rp(p, 'P') && p.median > 0);
  if (oppBatters.length < 3) return 0;
  const avg = oppBatters.reduce((s, p) => s + p.median, 0) / oppBatters.length;
  if (avg < 5) return 2; if (avg < 7) return 1; if (avg > 9) return -1; return 0;
}

function getEngineContext() {
  const pool = Engine.calibratePool(POOL);
  return { vegasData, parkFactors, weatherData, stadiums: stadiumData, teamScoring: TEAM_SCORING, contestSize, pool, optimalExposure, optimalStacks };
}

// Returns calibrated pool for optimizer calls — scoring functions score individual
// players from this pool, so calibration must be applied at the pool level
function getCalibratedPool() {
  return Engine.calibratePool(POOL);
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
      else if (type === 'roo') loadROO(res.data, file.name);
      else if (type === 'stacks') loadStackFile(res.data, file.name);
      else if (type === 'team_scoring') loadTeamScoring(res.data, file.name);
      else if (type === 'optimal') loadOptimalLineups(res.data, file.name);
      else showUploadWarn('unknown', file.name, res.meta.fields || []);
    }, error(err) { console.error('Parse error:', err); }
  });
}

function loadDK(data, fname) {
  DK_PLAYERS = data.map(r => {
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
  setFileStatus('dk', fname, DK_PLAYERS.length + ' players');
  document.getElementById('dk-export-btn').style.display = 'inline-block';
  MODE = 'dk';
  mergePools();
}

function loadROO(data, fname) {
  ROO = data.map(r => {
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
  setFileStatus('roo', fname, ROO.length + ' players');
  if (!DK_PLAYERS.length) MODE = 'roo';
  mergePools();
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

  if (size === 3) { STACKS3 = parsed; setFileStatus('s3', fname, parsed.length + ' 3-man stacks'); }
  else { STACKS5 = parsed; setFileStatus('s5', fname, parsed.length + ' 5-man stacks'); }

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
  TEAM_SCORING = {};
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
    TEAM_SCORING[team] = {
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
  const count = Object.keys(TEAM_SCORING).length;
  setFileStatus('ts', fname, count + ' teams');
  if (POOL.length) applyTeamScoringToPool();
  renderTeamScoringDisplay();
  checkAllLoaded();
}

function applyTeamScoringToPool() {
  POOL.forEach(p => {
    const ts = TEAM_SCORING[p.team];
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

  OPTIMAL_LINEUPS = data.map(r => {
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
        if (i < OPTIMAL_LINEUPS.length) {
          const vals = hashCols.map(k => parseInt(r[k] || 0) || 0);
          OPTIMAL_LINEUPS[i].stackCount = vals[0];
          OPTIMAL_LINEUPS[i].secondaryCount = vals[1];
        }
      });
    }
  }

  // Compute player exposure rates
  optimalExposure = {};
  const total = OPTIMAL_LINEUPS.length;
  OPTIMAL_LINEUPS.forEach(lu => {
    lu.players.forEach(name => {
      if (!optimalExposure[name]) optimalExposure[name] = { count: 0, pct: 0 };
      optimalExposure[name].count++;
    });
  });
  Object.keys(optimalExposure).forEach(name => {
    optimalExposure[name].pct = parseFloat((optimalExposure[name].count / total * 100).toFixed(1));
  });

  // Compute stack combo frequencies
  optimalStacks = {};
  OPTIMAL_LINEUPS.forEach(lu => {
    if (lu.stack) {
      if (!optimalStacks[lu.stack]) optimalStacks[lu.stack] = { primary: 0, secondary: 0, total: 0 };
      optimalStacks[lu.stack].primary++;
      optimalStacks[lu.stack].total++;
    }
    if (lu.secondary) {
      if (!optimalStacks[lu.secondary]) optimalStacks[lu.secondary] = { primary: 0, secondary: 0, total: 0 };
      optimalStacks[lu.secondary].secondary++;
      optimalStacks[lu.secondary].total++;
    }
  });
  // Convert to percentages
  Object.keys(optimalStacks).forEach(team => {
    optimalStacks[team].primaryPct = parseFloat((optimalStacks[team].primary / total * 100).toFixed(1));
    optimalStacks[team].secondaryPct = parseFloat((optimalStacks[team].secondary / total * 100).toFixed(1));
    optimalStacks[team].totalPct = parseFloat((optimalStacks[team].total / total * 100).toFixed(1));
  });

  // Apply optimal exposure to the player pool
  applyOptimalToPool();

  // Boost stack rankings based on optimal frequency
  applyOptimalToStacks();

  setFileStatus('opt', fname, total + ' lineups');
  checkAllLoaded();
  if (POOL.length) { renderPlayers(); renderStacks(); }
}

function applyOptimalToPool() {
  POOL.forEach(p => {
    const exp = optimalExposure[p.name];
    p.optExp = exp ? exp.pct : 0;
  });
}

function applyOptimalToStacks() {
  // Boost stack projection scores by optimal frequency
  const boostStacks = stacks => {
    stacks.forEach(s => {
      const os = optimalStacks[s.team];
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
  boostStacks(STACKS3);
  boostStacks(STACKS5);
}

function mergePools() {
  if (!DK_PLAYERS.length && !ROO.length) { POOL = []; updateUI(); return; }
  const rooMap = {};
  ROO.forEach(p => { rooMap[p.name.toLowerCase()] = p; });
  if (DK_PLAYERS.length && MODE === 'dk') {
    POOL = DK_PLAYERS.map(dk => {
      const p = { ...dk };
      const roo = rooMap[dk.name.toLowerCase()];
      if (roo) {
        p.hasRoo = true;
        p.floor = roo.floor; p.median = roo.median; p.ceiling = roo.ceiling;
        p.top = roo.top; p.own = roo.own; p.gpp = roo.gpp;
        p.order = roo.order; p.hand = roo.hand;
        if (!p.opp) p.opp = roo.opp;
        p.lev = Engine.calcLeverage(p, contestSize);
      }
      return p;
    });
    const matched = POOL.filter(p => p.hasRoo).length;
    const matchPct = Math.round(matched / ROO.length * 100);
    if (ROO.length > 0 && matched < ROO.length * 0.5) {
      showUploadWarn('mismatch', null, null, { matched, total: ROO.length, matchPct });
    } else { hideUploadWarn('mismatch'); }
  } else {
    POOL = ROO.map(p => ({ ...p, lev: Engine.calcLeverage(p, contestSize) }));
    hideUploadWarn('mismatch');
  }
  if (Object.keys(TEAM_SCORING).length) applyTeamScoringToPool();
  if (Object.keys(optimalExposure).length) applyOptimalToPool();
  updateUI();
  checkAllLoaded();
}

// ── UI Updates ────────────────────────────────────────────────────────────────
function updateUI() {
  playerLimit = 80;
  if (!POOL.length) return;
  const mi = document.getElementById('mode-indicator');
  mi.style.display = 'inline-flex';
  if (MODE === 'dk' && DK_PLAYERS.length) {
    mi.className = 'mode-badge dk-mode'; mi.textContent = 'DK Slate Mode';
  } else {
    mi.className = 'mode-badge roo-mode'; mi.textContent = 'ROO-Only Mode';
  }
  const teams = [...new Set(POOL.map(p => p.team))].filter(Boolean).sort();
  document.getElementById('team-sel').innerHTML = '<option value="ALL">All Teams</option>' + teams.map(t => `<option value="${t}">${t}</option>`).join('');
  const games = [...new Set(POOL.map(p => p.game).filter(Boolean))].sort();
  const gsel = document.getElementById('game-sel');
  if (games.length) { gsel.style.display = ''; gsel.innerHTML = '<option value="ALL">All Games</option>' + games.map(g => `<option value="${g}">${g}</option>`).join(''); }
  else { gsel.style.display = 'none'; }
  document.getElementById('player-empty').style.display = 'none';
  document.getElementById('player-content').style.display = 'block';
  document.getElementById('lineup-empty').style.display = 'none';
  document.getElementById('lineup-content').style.display = 'block';
  renderPlayers(); renderLineup(); renderLuPool(); renderStacks();
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
    msg = `<strong>Slate mismatch:</strong> Only ${extra.matched} of ${extra.total} ROO players (${extra.matchPct}%) matched to DK.`;
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
  const hasPlayers = DK_PLAYERS.length > 0 || ROO.length > 0;
  const hasStacks = STACKS3.length > 0 || STACKS5.length > 0;
  if (!hasPlayers && !hasStacks) return;
  document.getElementById('upload-status').style.display = 'block';
  const poolSize = POOL.length || ROO.length;
  const withProj = POOL.filter(p => p.median > 0).length || ROO.length;
  document.getElementById('upload-metrics').innerHTML = [
    { l: 'Players', v: poolSize, s: MODE === 'dk' ? 'on DK slate' : 'in ROO' },
    { l: 'With projections', v: withProj, s: MODE === 'dk' ? 'matched to ROO' : 'from ROO' },
    { l: '3-man stacks', v: STACKS3.length, s: STACKS3.length ? 'loaded' : 'not loaded' },
    { l: '5-man stacks', v: STACKS5.length, s: STACKS5.length ? 'loaded' : 'not loaded' },
    { l: 'Optimal lineups', v: OPTIMAL_LINEUPS.length, s: OPTIMAL_LINEUPS.length ? 'loaded' : 'not loaded' }
  ].map(m => `<div class="mc"><div class="mc-l">${m.l}</div><div class="mc-v">${m.v}</div><div class="mc-s">${m.s}</div></div>`).join('');
  const hasTeamScoring = Object.keys(TEAM_SCORING).length > 0;
  const hasOptimal = OPTIMAL_LINEUPS.length > 0;
  const count = [hasPlayers, STACKS3.length > 0, STACKS5.length > 0, hasTeamScoring, hasOptimal].filter(Boolean).length;
  document.getElementById('slate-badge').textContent = count + '/5 files loaded';
  document.getElementById('slate-badge').className = 'pill ' + (count >= 5 ? 'psu' : 'pw');
}

// ── Player Pool Rendering ─────────────────────────────────────────────────────
function setPos(p, btn) { curPos = p; playerLimit = 80; document.querySelectorAll('#pos-btns .pb').forEach(b => b.classList.remove('active')); btn.classList.add('active'); renderPlayers(); }
function setLuPos(p, btn) { luPos = p; document.querySelectorAll('#lu-pos-btns .pb').forEach(b => b.classList.remove('active')); btn.classList.add('active'); renderLuPool(); }
function setSortCol(c) { if (sortCol === c) sortDir *= -1; else { sortCol = c; sortDir = -1; } renderPlayers(); }
function showMorePlayers() { playerLimit += DISPLAY_LIMIT; renderPlayers(); }

function renderPlayers() {
  if (!POOL.length) return;
  const tf = document.getElementById('team-sel').value;
  const gf = document.getElementById('game-sel').value;
  const sf = document.getElementById('sort-sel').value;
  const q = (document.getElementById('search-inp').value || '').toLowerCase().trim();
  let data = POOL.filter(p => posMatchFilter(p, curPos) && (tf === 'ALL' || p.team === tf) && (gf === 'ALL' || !p.game || p.game === gf) && (!q || p.name.toLowerCase().includes(q)));
  const sc = sf || sortCol;
  data.sort((a, b) => {
    if (sc === 'name') return sortDir * (a.name.localeCompare(b.name));
    if (sc === 'value') return sortDir * ((b.median / b.salary || 0) - (a.median / a.salary || 0));
    if (sc === 'avgppg') return sortDir * (b.avgPpg - a.avgPpg);
    if (sc === 'gppScore') return sortDir * ((Engine.calcGppScore(b, contestSize)) - (Engine.calcGppScore(a, contestSize)));
    return sortDir * ((b[sc] || 0) - (a[sc] || 0));
  });
  const maxC = Math.max(...data.map(p => p.ceiling), 1);
  const usedNames = new Set(lineup.filter(Boolean).map(p => p.name));
  const displayData = data.slice(0, playerLimit);
  _playerPoolCache = displayData;
  const ctx = getEngineContext();
  document.getElementById('player-tbody').innerHTML = displayData.map((p, idx) => {
    const ow = p.own > 50 ? 'pd' : p.own > 25 ? 'pw' : p.own > 10 ? 'pi' : 'psu';
    const bw = Math.round(p.ceiling / maxC * 55);
    const lc = p.lev > 5 ? 'lp' : p.lev < -2 ? 'ln' : 'lz';
    const inLu = usedNames.has(p.name);
    const gppS = Engine.calcGppScore(p, contestSize);
    const platoonAdj = p.platoonAdj || 1.0;
    const platoonLabel = platoonAdj > 1.01 ? '<span class="pill psu" style="font-size:9px">+plat</span>' : platoonAdj < 0.99 ? '<span class="pill pd" style="font-size:9px">-plat</span>' : '';
    const optExpVal = p.optExp > 0 ? `<span class="pill ${p.optExp > 30 ? 'psu' : p.optExp > 10 ? 'pi' : 'pg'}">${p.optExp.toFixed(1)}%</span>` : '\u2014';
    const confirmedBadge = p.isConfirmed ? `<span class="pill psu" style="font-size:9px;margin-left:3px">${p.confirmedOrder ? '#' + p.confirmedOrder : 'SP'}</span>` : '';
    const scBadge = p.barrelRate > 0 ? `<span class="pill ${p.barrelRate >= 10 ? 'psu' : p.barrelRate >= 7 ? 'pi' : 'pg'}" style="font-size:9px;margin-left:3px">Brl:${p.barrelRate.toFixed(0)}%</span>` : '';
    const formColor = p.recentAvgDK && p.median > 0 ? (p.recentAvgDK / p.median >= 1.2 ? 'var(--tsu)' : p.recentAvgDK / p.median <= 0.8 ? 'var(--td)' : '') : '';
    const kDisplay = rp(p, 'P') && p.kRate > 0 ? `<span style="font-size:11px;color:${p.kRate > 25 ? 'var(--tsu)' : p.kRate > 20 ? 'var(--ti)' : 'var(--ts)'}">${p.kRate.toFixed(0)}%</span>` : '\u2014';
    return `<tr style="${inLu ? 'opacity:.38;' : ''}"><td><strong style="${formColor ? 'color:' + formColor : ''}">${esc(p.name)}</strong>${MODE === 'dk' && !p.hasRoo ? '<span style="font-size:10px;background:var(--bw);color:var(--tw);border-radius:3px;padding:1px 4px;margin-left:4px">no proj</span>' : ''}${confirmedBadge}${scBadge} ${platoonLabel}</td><td><span class="pill pi" style="font-size:10px">${esc(p.dkPos) || '\u2014'}</span></td><td>${esc(p.team)}</td><td>${p.salary > 0 ? '$' + p.salary.toLocaleString() : '\u2014'}</td><td>${p.order > 0 ? '#' + p.order : '\u2014'}</td><td>${p.floor > 0 ? p.floor.toFixed(1) : '\u2014'}</td><td>${p.median > 0 ? '<strong>' + p.median.toFixed(1) + '</strong>' : '\u2014'}</td><td>${p.ceiling > 0 ? `<div class="bar-w"><div class="bar" style="width:${bw}px"></div><span style="font-size:11px;color:var(--ts)">${p.ceiling.toFixed(1)}</span></div>` : '\u2014'}</td><td>${p.own > 0 ? `<span class="pill ${ow}">${p.own.toFixed(1)}%</span>` : '\u2014'}</td><td class="${lc}">${p.lev !== 0 ? (p.lev > 0 ? '+' : '') + p.lev.toFixed(1) : '\u2014'}</td><td style="color:var(--ti);font-weight:500">${gppS > 0 ? gppS.toFixed(1) : '\u2014'}</td><td>${optExpVal}</td><td>${p.avgPpg > 0 ? p.avgPpg.toFixed(1) : '\u2014'}</td><td>${kDisplay}</td><td><button class="btn" style="padding:3px 8px;font-size:11px" ${inLu ? 'disabled' : ''} onclick="addPlayerByPoolIdx(${idx})">+</button></td></tr>`;
  }).join('');
  document.getElementById('player-more').style.display = data.length > playerLimit ? 'block' : 'none';
}

// ── Stacks Rendering ──────────────────────────────────────────────────────────
function renderStacks() {
  const allStacks = [...STACKS3, ...STACKS5];
  if (!allStacks.length) return;
  const poolTeams = new Set(POOL.map(p => p.team));
  const stackTeams = [...new Set(allStacks.map(s => s.team))];
  const offSlate = stackTeams.filter(t => poolTeams.size > 0 && !poolTeams.has(t));
  const warnEl = document.getElementById('stacks-slate-warn');
  if (offSlate.length > 0 && POOL.length > 0) {
    warnEl.style.display = 'block'; warnEl.className = 'ib warn';
    warnEl.innerHTML = `<strong>Off-slate teams:</strong> ${esc(offSlate.join(', '))}`;
  } else { warnEl.style.display = 'none'; }

  const tf = document.getElementById('stack-team-sel').value;
  const typeF = document.getElementById('stack-type-sel').value;
  const sf = document.getElementById('stack-sort-sel').value;
  const poolNames = new Set(POOL.map(p => p.name.toLowerCase()));
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
  if (typeF === 'ALL' || typeF === '3') html += renderGroup(STACKS3, '3-man stacks', 's3');
  if (typeF === 'ALL' || typeF === '5') html += renderGroup(STACKS5, '5-man stacks', 's5');
  document.getElementById('stacks-container').innerHTML = html || '<div class="empty" style="padding:20px">No stacks match filters.</div>';
}

// ── Lineup Builder ────────────────────────────────────────────────────────────
function getSalaryUsed() { return lineup.reduce((s, p) => s + (p ? p.salary : 0), 0); }

function renderLineup() {
  document.getElementById('lineup-slots').innerHTML = DK_SLOTS.map((slot, i) => {
    const p = lineup[i];
    if (!p) return `<div class="lu-slot"><div class="slot-pos">${slot.label}</div><div class="slot-empty">Empty</div></div>`;
    const ownDisplay = p.own > 0 ? ` \u00B7 ${p.own.toFixed(1)}% own` : '';
    return `<div class="lu-slot filled"><div class="slot-pos">${slot.label}</div><div style="flex:1"><div class="slot-name">${esc(p.name)}</div><div class="slot-info">${esc(p.dkPos || p.rosterPos)} \u00B7 ${esc(p.team)}${p.opp ? ' vs ' + esc(p.opp) : ''} \u00B7 $${p.salary.toLocaleString()}${ownDisplay}</div></div><button class="slot-rm" onclick="removeFromLineup(${i})">x</button></div>`;
  }).join('');
  const used = getSalaryUsed(), rem = CAP - used, pct = Math.min(used / CAP * 100, 100);
  document.getElementById('sal-used').textContent = '$' + used.toLocaleString();
  const re = document.getElementById('sal-remain');
  re.textContent = rem >= 0 ? '$' + rem.toLocaleString() + ' left' : 'OVER by $' + Math.abs(rem).toLocaleString();
  re.style.color = rem < 0 ? 'var(--td)' : rem < 3000 ? 'var(--tw)' : 'var(--tsu)';
  document.getElementById('sal-bar').style.width = pct + '%';
  document.getElementById('sal-bar').className = 'sal-bar' + (rem < 0 ? ' over' : rem < 5000 ? ' warn' : '');

  const playersInLineup = lineup.filter(Boolean);
  const totalMedian = playersInLineup.reduce((sum, p) => sum + (p.median || 0), 0);
  const avgOwnership = playersInLineup.reduce((sum, p) => sum + (p.own || 0), 0);
  document.getElementById('median-total').textContent = totalMedian.toFixed(1);
  document.getElementById('own-avg').textContent = avgOwnership.toFixed(1);

  const warns = [];
  if (rem < 0) warns.push('Over $50k salary cap');
  const filled = playersInLineup.length;
  if (filled > 0 && filled < ROSTER_SIZE) warns.push(`${ROSTER_SIZE - filled} slot${ROSTER_SIZE - filled > 1 ? 's' : ''} empty`);
  const wEl = document.getElementById('lineup-warns');
  wEl.style.display = warns.length ? 'block' : 'none';
  if (warns.length) { wEl.className = 'ib warn'; wEl.innerHTML = warns.map(w => w).join('<br>'); }
  checkPositionScarcity();
}

function renderLuPool() {
  if (!POOL.length) return;
  const usedNames = new Set(lineup.filter(Boolean).map(p => p.name));
  _luPoolCache = POOL.filter(p => posMatchFilter(p, luPos)).sort((a, b) => b.median - a.median || b.avgPpg - a.avgPpg).slice(0, 100);
  document.getElementById('lu-pool-tbody').innerHTML = _luPoolCache.map((p, idx) => {
    const inLu = usedNames.has(p.name);
    return `<tr style="${inLu ? 'opacity:.35;' : ''}"><td>${esc(p.name)}</td><td style="color:var(--tt);font-size:11px">${esc(p.dkPos) || '\u2014'}</td><td>${esc(p.team)}</td><td>$${p.salary.toLocaleString()}</td><td>${p.median > 0 ? p.median.toFixed(1) : '\u2014'}</td><td>${p.own > 0 ? p.own.toFixed(1) + '%' : '\u2014'}</td><td><button class="btn" style="padding:2px 7px;font-size:11px" ${inLu ? 'disabled' : ''} onclick="addPlayerByLuIdx(${idx})">+</button></td></tr>`;
  }).join('');
}

function addToLineupByName(name) { const p = POOL.find(r => r.name === name); if (p) addToLineup(p); }
function addToLineup(p) {
  if (!p) return;
  if (lineup.some(lp => lp && lp.name === p.name)) return;
  for (let i = 0; i < DK_SLOTS.length; i++) {
    if (lineup[i]) continue;
    if (!DK_SLOTS[i].eligible(p)) continue;
    if (getSalaryUsed() + p.salary > CAP) return;
    lineup[i] = p; renderLineup(); renderLuPool(); return;
  }
}
function useStackById(id) {
  const s = [...STACKS3, ...STACKS5].find(st => st.id === id);
  if (!s) return;
  s.players.forEach(name => { const p = POOL.find(r => r.name === name); if (p) addToLineup(p); });
  showTab('lineup');
}
function removeFromLineup(i) { lineup[i] = null; renderLineup(); renderLuPool(); }
function clearLineup() { lineup = new Array(ROSTER_SIZE).fill(null); renderLineup(); renderLuPool(); document.getElementById('export-out').style.display = 'none'; }

// ── Auto-fill / Generate Lineups (using Engine) ──────────────────────────────
function autoFill() {
  clearLineup();
  const ctx = getEngineContext();
  const pool = getCalibratedPool();
  const contestType = document.getElementById('contest-type-sel')?.value || 'single';
  let scoreFn;
  if (contestType === 'cash') scoreFn = p => Engine.scoreCash(p, ctx);
  else if (contestType === 'gpp') scoreFn = p => Engine.scoreGpp(p, ctx);
  else scoreFn = p => Engine.scoreSingle(p, ctx);

  const stackBonusFn = contestType === 'gpp' ? lu => Engine.gppStackBonus(lu, null) : null;
  lineup = Engine.optimizeLineup(pool, scoreFn, { iterations: OPTIMIZER_ITERATIONS, stackBonusFn }) || new Array(ROSTER_SIZE).fill(null);
  renderLineup(); renderLuPool();
}

function generateThreeLineups() {
  if (!POOL.length) return;
  generatedLineups = [];
  const ctx = getEngineContext();
  const pool = getCalibratedPool();

  const cashLu = Engine.generateCashLineup(pool, new Set(), ctx, OPTIMIZER_ITERATIONS);
  generatedLineups.push(cashLu);

  const cashNames = new Set(cashLu.filter(Boolean).map(p => p.name));
  const cashExclude = new Set();
  const shuffled1 = [...cashNames]; for (let i = shuffled1.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shuffled1[i], shuffled1[j]] = [shuffled1[j], shuffled1[i]]; }
  shuffled1.slice(0, Math.floor(shuffled1.length * 0.4)).forEach(nm => cashExclude.add(nm));
  const singleLu = Engine.generateSingleLineup(pool, cashExclude, ctx, OPTIMIZER_ITERATIONS);
  generatedLineups.push(singleLu);

  const allUsed = new Set([...cashNames, ...singleLu.filter(Boolean).map(p => p.name)]);
  const gppExclude = new Set();
  const shuffled2 = [...allUsed]; for (let i = shuffled2.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shuffled2[i], shuffled2[j]] = [shuffled2[j], shuffled2[i]]; }
  shuffled2.slice(0, Math.floor(shuffled2.length * 0.5)).forEach(nm => gppExclude.add(nm));
  const usedStackIds = new Set();
  const gppLu = Engine.generateGppLineup(pool, gppExclude, ctx, STACKS3, STACKS5, usedStackIds, OPTIMIZER_ITERATIONS, contestSize);
  generatedLineups.push(gppLu);

  displayThreeLineups();
}

function displayThreeLineups() {
  const types = [
    { name: 'CASH', lineup: generatedLineups[0], strategy: 'High Floor / Batting Order / Pitcher Matchups' },
    { name: 'SINGLE ENTRY', lineup: generatedLineups[1], strategy: 'Balanced Upside / Salary Value / Optimal Median' },
    { name: 'GPP', lineup: generatedLineups[2], strategy: 'Ceiling Chase / Stacking / Low Own / Bring-backs' }
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
  lineup = [...generatedLineups[0]];
  renderLineup(); renderLuPool();
}

// ── Export ─────────────────────────────────────────────────────────────────────
function exportLineup() {
  if (!lineup.filter(Boolean).length) return;
  const rows = [['Slot', 'Player', 'Pos', 'Team', 'Salary', 'Median']];
  lineup.forEach((p, i) => {
    rows.push(p ? [DK_SLOTS[i].label, p.name, p.dkPos || '', p.team, '$' + p.salary, p.median > 0 ? p.median.toFixed(1) : ''] : [DK_SLOTS[i].label, 'EMPTY', '', '', '', '']);
  });
  dlFile(rows.map(r => r.join(',')).join('\n'), 'lineups.csv', 'text/csv');
}
function exportDK() {
  const filled = lineup.filter(Boolean);
  if (!filled.length) return;
  const missing = filled.filter(p => !p.dkId);
  if (missing.length) {
    alert('Missing DK IDs for: ' + missing.map(p => p.name).join(', ') + '\nUpload your DK Salaries CSV first.');
    return;
  }
  const header = DK_SLOTS.map(s => s.label).join(',');
  const row = lineup.map(p => p ? p.dkId : '').join(',');
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
// ═══════════════════════════════════════════════════════════════════════════════
async function loadVegasWeatherData() {
  try {
    const [vegasRes, parkRes, stadiumRes] = await Promise.all([
      fetch('/api/vegas').then(r => r.json()),
      fetch('/api/park-factors').then(r => r.json()),
      fetch('/api/stadiums').then(r => r.json())
    ]);
    vegasData = vegasRes && Object.keys(vegasRes).length ? vegasRes : null;
    parkFactors = parkRes;
    stadiumData = stadiumRes;
    renderVegasPanel();
    await loadWindEffects();
    renderSlateEnvironment();
  } catch (e) { console.error('Failed to load vegas/weather data:', e); }
}

function renderVegasPanel() {
  const games = [...new Set(POOL.map(p => p.game).filter(Boolean))];
  const teams = [...new Set(POOL.map(p => p.team).filter(Boolean))].sort();
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

  let html = '<div style="display:grid;gap:8px">';
  if (Object.keys(gameTeams).length) {
    Object.entries(gameTeams).forEach(([game, { away, home }]) => {
      const awayData = vegasData?.[away] || {};
      const homeData = vegasData?.[home] || {};
      const pf = parkFactors?.[home] || { overall: 1.0, hr: 1.0, run: 1.0 };
      html += `<div class="sk-card">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
          <strong>${esc(away)} @ ${esc(home)}</strong>
          <span class="pill pg">PF: ${pf.overall.toFixed(2)} / HR: ${pf.hr.toFixed(2)}</span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div>
            <label style="font-size:11px;color:var(--tt)">${esc(away)} Implied Total</label>
            <input type="number" step="0.1" min="0" max="15" class="vegas-input" data-team="${escAttr(away)}" data-field="impliedTotal" value="${awayData.impliedTotal || ''}" placeholder="4.5" style="width:100%;padding:5px 8px;border-radius:var(--r);border:0.5px solid var(--brd-s);background:var(--bp);color:var(--tp);font-size:12px">
          </div>
          <div>
            <label style="font-size:11px;color:var(--tt)">${esc(home)} Implied Total</label>
            <input type="number" step="0.1" min="0" max="15" class="vegas-input" data-team="${escAttr(home)}" data-field="impliedTotal" value="${homeData.impliedTotal || ''}" placeholder="4.5" style="width:100%;padding:5px 8px;border-radius:var(--r);border:0.5px solid var(--brd-s);background:var(--bp);color:var(--tp);font-size:12px">
          </div>
        </div>
      </div>`;
    });
  } else {
    teams.forEach(team => {
      const teamData = vegasData?.[team] || {};
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
    }
  });
  vegasData = Object.keys(data).length ? data : null;
  fetch('/api/vegas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
    .then(() => {
      const btn = document.getElementById('save-vegas-btn');
      btn.textContent = 'Saved!'; btn.className = 'btn-g';
      setTimeout(() => { btn.textContent = 'Save Vegas Lines'; btn.className = 'btn-p'; }, 1500);
      // Recalculate leverage with vegas data
      if (POOL.length) mergePools();
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

    // Store as vegasData and populate inputs
    if (!vegasData) vegasData = {};
    Object.entries(teams).forEach(([abbr, info]) => {
      vegasData[abbr] = { impliedTotal: info.impliedTotal };
    });

    // Populate input fields if the panel is rendered
    document.querySelectorAll('.vegas-input[data-field="impliedTotal"]').forEach(inp => {
      const team = inp.dataset.team;
      if (teams[team]) inp.value = teams[team].impliedTotal;
    });

    // Auto-save to server
    fetch('/api/vegas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(vegasData) });

    // Recalculate pool with new vegas data
    if (POOL.length) mergePools();

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
  if (!parkFactors) { el.innerHTML = '<div class="empty">Loading park factors...</div>'; return; }
  const teams = Object.keys(parkFactors).sort((a, b) => parkFactors[b].overall - parkFactors[a].overall);
  el.innerHTML = `<div style="max-height:300px;overflow-y:auto"><table><thead><tr><th>Team</th><th>Overall</th><th>HR</th><th>Run</th></tr></thead><tbody>${teams.map(t => {
    const pf = parkFactors[t];
    const color = pf.overall > 1.05 ? 'var(--tsu)' : pf.overall < 0.95 ? 'var(--td)' : 'var(--ts)';
    return `<tr><td><strong>${t}</strong></td><td style="color:${color};font-weight:500">${pf.overall.toFixed(2)}</td><td>${pf.hr.toFixed(2)}</td><td>${pf.run.toFixed(2)}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}

async function fetchWeather() {
  const el = document.getElementById('weather-display');
  if (!stadiumData) {
    try { stadiumData = await fetch('/api/stadiums').then(r => r.json()); } catch (e) {
      el.innerHTML = '<div class="ib warn">Failed to load stadium data. Make sure the server is running on localhost:3000.</div>';
      return;
    }
  }
  const teams = [...new Set(POOL.map(p => p.team).filter(Boolean))];
  const cities = [...new Set(teams.map(t => stadiumData.cities?.[t]).filter(Boolean))];
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
    weatherData = await res.json();
    renderWeatherDisplay();
    await loadWindEffects();
    renderSlateEnvironment();
    btn.textContent = 'Refresh Weather'; btn.disabled = false;
  } catch (e) {
    btn.textContent = 'Fetch Failed'; btn.disabled = false;
    console.error('Weather fetch failed:', e);
  }
}

function renderWeatherDisplay() {
  const el = document.getElementById('weather-display');
  if (!weatherData || !Object.keys(weatherData).length) {
    el.innerHTML = '<div class="empty" style="padding:16px">Click "Fetch Weather" to load current conditions.</div>';
    return;
  }
  const domes = stadiumData?.domes || [];
  const cityToTeams = {};
  if (stadiumData?.cities) {
    Object.entries(stadiumData.cities).forEach(([team, city]) => {
      if (!cityToTeams[city]) cityToTeams[city] = [];
      cityToTeams[city].push(team);
    });
  }

  el.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px">${Object.entries(weatherData).map(([city, w]) => {
    if (w.error) return `<div class="sk-card"><strong>${esc(city)}</strong><div style="color:var(--td);font-size:11px">Error: ${esc(w.error)}</div></div>`;
    const wm = Engine.weatherMultiplier(w);
    const teams = cityToTeams[city] || [];
    const isDome = teams.some(t => domes.includes(t));
    return `<div class="sk-card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <strong style="font-size:12px">${esc(city)}</strong>
        ${isDome ? '<span class="pill pg" style="font-size:9px">DOME</span>' : `<span class="pill ${wm.risk === 'high' ? 'pd' : wm.risk === 'moderate' ? 'pw' : 'psu'}" style="font-size:9px">${wm.label}</span>`}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:11px">
        <div>Temp: <strong>${w.temp_f || '?'}F</strong></div>
        <div>Wind: <strong>${w.wind_mph || '?'} mph</strong></div>
        <div>Precip: <strong>${w.precip_chance || 0}%</strong></div>
        <div>Hit mult: <strong style="color:${wm.hitting > 1.02 ? 'var(--tsu)' : wm.hitting < 0.98 ? 'var(--td)' : 'var(--ts)'}">${isDome ? '1.00' : wm.hitting.toFixed(2)}</strong></div>
      </div>
    </div>`;
  }).join('')}</div>`;
}

function renderTeamScoringDisplay() {
  const el = document.getElementById('team-scoring-display');
  const teams = Object.keys(TEAM_SCORING).sort();
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
      const s = TEAM_SCORING[t];
      const adj = Engine.teamScoringAdjustment({ team: t, opp: '', rosterPos: '' }, TEAM_SCORING);
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

// Populate lock/ban team chip selectors from the current pool
function renderPortfolioTeamSelectors() {
  const teams = [...new Set(POOL.map(p => p.team).filter(Boolean))].sort();
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
  const viablePitchers = POOL.filter(p => rp(p, 'P') && p.salary > 0 && (p.median > 0 || p.avgPpg > 0)).length;
  const neededPitcherAppearances = 2 * numLineups; // 2 P slots per lineup
  const maxPitcherAppearances = Math.ceil(viablePitchers * pitcherMaxPct * numLineups);
  if (viablePitchers > 0 && maxPitcherAppearances < neededPitcherAppearances) {
    warnings.push(`<strong>Pitcher exposure too low:</strong> ${viablePitchers} viable pitchers at ${Math.round(pitcherMaxPct * 100)}% max = ~${maxPitcherAppearances} total appearances, but ${neededPitcherAppearances} are needed (${numLineups} lineups × 2 P slots). Some pitchers will exceed their cap or lineups will fail. Raise pitcher exposure or reduce lineup count.`);
  }

  // Warn if a locked team has no stack in the stacks files
  lockedTeams.forEach(team => {
    const hasStack = [...STACKS3, ...STACKS5].some(s => s.team === team);
    if (!hasStack) {
      const batters = POOL.filter(p => p.team === team && !rp(p, 'P') && p.median > 0);
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
  if (!POOL.length) return;
  const numLineups = parseInt(document.getElementById('port-num-lineups').value) || 20;
  const maxExposure = parseInt(document.getElementById('port-max-exposure').value) / 100 || 0.6;
  const maxExposurePitcher = parseInt(document.getElementById('port-max-pitcher').value) / 100 || 0.6;
  const contestType = document.getElementById('port-contest-type').value || 'gpp';
  const portContestSize = parseInt(document.getElementById('port-contest-size').value) || 1000;
  const maxOverlapVal = parseInt(document.getElementById('port-max-overlap')?.value) || 0;
  const lockedTeams = getCheckedTeams('port-lock-teams');
  const bannedTeams = getCheckedTeams('port-ban-teams');

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
      stacks3: STACKS3, stacks5: STACKS5,
      lockedTeams, bannedTeams,
      context: ctx, iterations: OPTIMIZER_ITERATIONS
    });
    portfolioLineups = result.lineups;
    portfolioExposure = result.playerExposure;
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

  html += `<div style="margin-top:12px"><button class="btn-p" onclick="exportPortfolio()">Export All Lineups CSV</button></div>`;

  el.innerHTML = html;
}

function togglePortfolioLineups() {
  const el = document.getElementById('portfolio-lineup-list');
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

function exportPortfolio() {
  if (!portfolioLineups.length) return;
  const allPlayers = portfolioLineups.flat().filter(Boolean);
  const missing = allPlayers.filter(p => !p.dkId);
  if (missing.length) {
    const unique = [...new Set(missing.map(p => p.name))];
    alert('Missing DK IDs for: ' + unique.slice(0, 5).join(', ') + (unique.length > 5 ? '...' : '') + '\nUpload your DK Salaries CSV first.');
    return;
  }
  const header = DK_SLOTS.map(s => s.label).join(',');
  const rows = portfolioLineups.map(lu => lu.map(p => p ? p.dkId : '').join(','));
  dlFile(header + '\n' + rows.join('\n'), 'portfolio_lineups.csv', 'text/csv');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIMULATOR TAB (Monte Carlo)
// ═══════════════════════════════════════════════════════════════════════════════
function runSimulation() {
  const playersInLineup = lineup.filter(Boolean);
  if (playersInLineup.length < 5) {
    document.getElementById('sim-results').innerHTML = '<div class="ib warn">Add at least 5 players to your lineup to simulate.</div>';
    return;
  }
  const numSims = parseInt(document.getElementById('sim-count').value) || 10000;
  const btn = document.getElementById('run-sim-btn');
  btn.textContent = 'Simulating...'; btn.disabled = true;

  setTimeout(() => {
    const result = Engine.simulateLineup(lineup, numSims);
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
    historyData = history;
    renderBacktestPanel(history, summary);
  } catch (e) { console.error('Failed to load history:', e); }
}

function renderBacktestPanel(history, summary) {
  const summaryEl = document.getElementById('backtest-summary');
  const historyEl = document.getElementById('backtest-history');

  // Summary cards
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

  historyEl.innerHTML = saveHtml + histHtml;
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
  const players = lineup.filter(Boolean);
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
  const poolSnapshot = POOL.map(p => ({
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
    confirmedLineups = {};
    (data.games || []).forEach(g => { confirmedLineups[g.gamePk] = g; });
    applyConfirmedToPool();
    const confirmedCount = Object.values(confirmedLineups).filter(g => g.confirmed).length;
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
  if (!Object.keys(confirmedLineups).length) return;
  const orderMap = {};
  const confirmedNames = new Set();
  Object.values(confirmedLineups).forEach(g => {
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
  Object.values(confirmedLineups).forEach(g => {
    if (g.homeProbable) probablePitchers.add(g.homeProbable.toLowerCase().replace(/[^a-z ]/g, '').trim());
    if (g.awayProbable) probablePitchers.add(g.awayProbable.toLowerCase().replace(/[^a-z ]/g, '').trim());
  });

  POOL.forEach(p => {
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
    statcastData = data.data || {};
    applyStatcastToPool();
    const matchCount = POOL.filter(p => {
      const key = p.name.toLowerCase().replace(/[^a-z ]/g, '').trim();
      return !!statcastData[key];
    }).length;
    if (el) {
      const cacheInfo = data.cached ? ` (cached ${new Date(data.fetchedAt).toLocaleDateString()})` : '';
      el.innerHTML = `<div class="ib success">Loaded ${data.count} Statcast profiles · ${matchCount} matched to player pool${cacheInfo}${data.stale ? ' · stale data' : ''}</div>`;
    }
    if (btn) { btn.textContent = 'Refresh Statcast'; btn.disabled = false; }
    renderPlayers();
  } catch (e) {
    if (el) el.innerHTML = `<div class="ib warn">Statcast failed: ${esc(e.message)}</div>`;
    if (btn) { btn.textContent = 'Fetch Statcast'; btn.disabled = false; }
  }
}

function applyStatcastToPool() {
  POOL.forEach(p => {
    if (rp(p, 'P')) return;
    const key = p.name.toLowerCase().replace(/[^a-z ]/g, '').trim();
    const sc = statcastData[key];
    if (sc) {
      p.barrelRate = sc.barrelRate;
      p.hardHitRate = sc.hardHitRate;
      p.xwOBA = sc.xwOBA;
      p.xSLG = sc.xSLG;
      p.exitVelo = sc.exitVelo;
    }
  });
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
    formData = data.data || {};
    applyFormToPool();
    const matchCount = POOL.filter(p => {
      const key = p.name.toLowerCase().replace(/[^a-z ]/g, '').trim();
      return !!formData[key];
    }).length;
    if (el) {
      el.innerHTML = `<div class="ib success">Loaded ${data.playerCount} players · ${matchCount} matched · last 14 days${data.stale ? ' (stale)' : ''}</div>`;
    }
    if (btn) { btn.textContent = 'Refresh Form'; btn.disabled = false; }
    renderPlayers();
  } catch (e) {
    if (el) el.innerHTML = `<div class="ib warn">Form fetch failed: ${esc(e.message)}</div>`;
    if (btn) { btn.textContent = 'Fetch Form'; btn.disabled = false; }
  }
}

function applyFormToPool() {
  POOL.forEach(p => {
    const key = p.name.toLowerCase().replace(/[^a-z ]/g, '').trim();
    const f = formData[key];
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

// ── Wind Effects ──────────────────────────────────────────────────────────────
async function loadWindEffects() {
  if (!weatherData || !stadiumData) return;
  windEffects = {};
  const teams = [...new Set(POOL.map(p => p.team).filter(Boolean))];
  for (const team of teams) {
    const city = stadiumData.cities?.[team];
    if (!city || !weatherData[city]) continue;
    const w = weatherData[city];
    if (w.error) continue;
    try {
      const res = await fetch(`/api/wind-effect/${team}?wind_dir=${encodeURIComponent(w.wind_dir || '')}&wind_mph=${w.wind_mph || 0}`);
      const data = await res.json();
      windEffects[team] = data.effect || 0;
    } catch (e) { windEffects[team] = 0; }
  }
}

// ── Slate Environment (Game Summary) ─────────────────────────────────────────
function renderSlateEnvironment() {
  const el = document.getElementById('slate-environment');
  if (!el) return;
  const games = [...new Set(POOL.map(p => p.game).filter(Boolean))];
  if (!games.length) {
    el.innerHTML = '<div class="empty" style="padding:12px">Load player data to see game environment rankings.</div>';
    return;
  }

  const gameEnvs = games.map(game => {
    const [away, home] = game.split('@');
    const homeVegas = vegasData?.[home] || {};
    const awayVegas = vegasData?.[away] || {};
    const total = (homeVegas.impliedTotal || 0) + (awayVegas.impliedTotal || 0);
    const pf = parkFactors?.[home] || { overall: 1.0, hr: 1.0 };
    const city = stadiumData?.cities?.[home];
    const isDome = stadiumData?.domes?.includes(home);
    const weather = city && weatherData?.[city] && !weatherData[city].error ? weatherData[city] : null;
    const wm = weather ? Engine.weatherMultiplier(weather) : { hitting: 1.0, risk: 'none' };
    const we = windEffects[home] || 0;
    const windLabel = we > 0.3 ? 'OUT' : we < -0.3 ? 'IN' : 'N';
    const envScore = total * pf.overall * wm.hitting * (isDome ? 1.0 : 1.0);
    return { game, away, home, total, homeImplied: homeVegas.impliedTotal || 0,
      awayImplied: awayVegas.impliedTotal || 0, pf, weather, wm, isDome, windLabel, we, envScore };
  }).filter(g => g.total > 0 || !vegasData).sort((a, b) => b.envScore - a.envScore);

  if (!gameEnvs.length) {
    el.innerHTML = '<div class="empty" style="padding:12px">Enter Vegas lines to see game environment rankings.</div>';
    return;
  }

  el.innerHTML = `<div class="tbl-wrap"><table>
    <thead><tr><th>Game</th><th>O/U</th><th>Away Impl</th><th>Home Impl</th><th>Park</th><th>Weather</th><th>Wind</th><th>Rain</th><th>Env Score</th></tr></thead>
    <tbody>${gameEnvs.map((g, i) => {
      const rankColor = i === 0 ? 'var(--tsu)' : i < 3 ? 'var(--ti)' : 'var(--ts)';
      const rainRisk = g.weather?.precip_chance || 0;
      const rainColor = rainRisk >= 50 ? 'var(--td)' : rainRisk >= 30 ? 'var(--tw)' : 'var(--tsu)';
      return `<tr>
        <td><strong style="color:${rankColor}">#${i+1} ${esc(g.away)}@${esc(g.home)}</strong></td>
        <td><strong>${g.total > 0 ? g.total.toFixed(1) : '\u2014'}</strong></td>
        <td>${g.awayImplied > 0 ? g.awayImplied.toFixed(1) : '\u2014'}</td>
        <td>${g.homeImplied > 0 ? g.homeImplied.toFixed(1) : '\u2014'}</td>
        <td><span class="pill ${g.pf.overall > 1.05 ? 'psu' : g.pf.overall < 0.95 ? 'pd' : 'pg'}">${g.pf.overall.toFixed(2)}</span></td>
        <td>${g.isDome ? '<span class="pill pg">Dome</span>' : g.weather ? `${g.weather.temp_f}F` : '\u2014'}</td>
        <td><span class="pill ${g.windLabel === 'OUT' ? 'psu' : g.windLabel === 'IN' ? 'pd' : 'pg'}">${g.windLabel}</span></td>
        <td style="color:${rainColor}">${rainRisk > 0 ? rainRisk + '%' : '\u2014'}</td>
        <td style="color:${rankColor};font-weight:500">${g.envScore > 0 ? g.envScore.toFixed(1) : '\u2014'}</td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

// ── Value Scatter Plot (SVG) ───────────────────────────────────────────────────
function renderValueScatter() {
  const el = document.getElementById('value-scatter');
  if (!el || !POOL.length) return;
  const W = Math.min(el.offsetWidth || 500, 600), H = 280;
  const PAD = { left: 40, right: 20, top: 15, bottom: 35 };
  const data = POOL.filter(p => p.salary > 0 && p.median > 0);
  if (data.length < 5) { el.innerHTML = '<div class="empty" style="padding:20px">Need salary + projection data for scatter.</div>'; return; }

  const minSal = Math.min(...data.map(p => p.salary));
  const maxSal = Math.max(...data.map(p => p.salary));
  const maxMed = Math.max(...data.map(p => p.median));
  const posColors = { P:'#4a9de0', C:'#e0884a', '1B':'#4ae068', '2B':'#b44ae0', '3B':'#e04a4a', SS:'#e0c44a', OF:'#4ae0c4' };

  const scaleX = (s) => PAD.left + (s - minSal) / (maxSal - minSal) * (W - PAD.left - PAD.right);
  const scaleY = (m) => H - PAD.bottom - (m / maxMed) * (H - PAD.top - PAD.bottom);

  const dots = data.map(p => {
    const x = scaleX(p.salary), y = scaleY(p.median);
    const pos = (p.dkPos || '').split('/')[0];
    const col = posColors[pos] || posColors[rp(p, 'P') ? 'P' : 'OF'] || '#888';
    const isInLu = lineup.some(lp => lp && lp.name === p.name);
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${isInLu ? 6 : 3.5}" fill="${col}" opacity="${isInLu ? 1 : 0.55}" stroke="${isInLu ? '#fff' : 'none'}" stroke-width="1.5">
      <title>${esc(p.name)} (${esc(p.dkPos)}) $${p.salary.toLocaleString()} / ${p.median.toFixed(1)}pts${p.own > 0 ? ' / ' + p.own.toFixed(1) + '%own' : ''}</title>
    </circle>`;
  }).join('');

  el.innerHTML = `<svg width="${W}" height="${H}" style="display:block;overflow:visible">
    <line x1="${PAD.left}" y1="${H - PAD.bottom}" x2="${W - PAD.right}" y2="${H - PAD.bottom}" stroke="var(--brd-t)" stroke-width="0.5"/>
    <line x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${H - PAD.bottom}" stroke="var(--brd-t)" stroke-width="0.5"/>
    <text x="${(W + PAD.left - PAD.right) / 2}" y="${H - 5}" font-size="10" fill="var(--tt)" text-anchor="middle">Salary</text>
    <text x="10" y="${(H + PAD.top - PAD.bottom) / 2}" font-size="10" fill="var(--tt)" text-anchor="middle" transform="rotate(-90 10 ${(H + PAD.top - PAD.bottom) / 2})">Median</text>
    ${dots}
    <g transform="translate(${PAD.left + 5}, ${PAD.top + 5})">
      ${Object.entries(posColors).map(([pos, col], i) =>
        `<g transform="translate(${(i % 4) * 38}, ${Math.floor(i / 4) * 14})"><circle cx="0" cy="0" r="3.5" fill="${col}"/><text x="6" y="4" font-size="9" fill="var(--ts)">${pos}</text></g>`
      ).join('')}
    </g>
  </svg>`;
}

// ── Position Scarcity ─────────────────────────────────────────────────────────
function checkPositionScarcity() {
  const el = document.getElementById('position-scarcity');
  if (!el || !POOL.length) return;
  const usedNames = new Set(lineup.filter(Boolean).map(p => p.name));
  const budget = CAP - getSalaryUsed();
  const warns = [];

  const posCheck = [
    { key: 'C', label: 'C', minViable: 4 },
    { key: '2B', label: '2B', minViable: 5 },
    { key: 'SS', label: 'SS', minViable: 5 },
    { key: '3B', label: '3B', minViable: 5 },
  ];

  posCheck.forEach(({ key, label, minViable }) => {
    const already = lineup.filter(Boolean).some(p => rp(p, key));
    if (already) return;
    const available = POOL.filter(p => rp(p, key) && !usedNames.has(p.name) && p.salary <= budget && p.salary > 0).length;
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
  if (!ROO.length) { el.innerHTML = '<span style="font-size:11px;color:var(--tt)">Upload additional projection CSVs to enable blending.</span>'; return; }
  el.innerHTML = `<span style="font-size:11px;color:var(--tt)">Upload additional projection CSVs to enable blending.</span>`;
}

// ── Init: Load park factors on startup ────────────────────────────────────────
(async function init() {
  try {
    parkFactors = await fetch('/api/park-factors').then(r => r.json());
    stadiumData = await fetch('/api/stadiums').then(r => r.json());
    // Load saved calibration and apply to engine
    const cal = await fetch('/api/calibration').then(r => r.json());
    Engine.setCalibration(cal);
  } catch (e) { /* Server may not be running during dev */ }
})();
