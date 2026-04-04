require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const fetch = require('node-fetch');

// Centralized fetch wrapper — consistent User-Agent, default timeout, error format
function apiFetch(url, opts = {}) {
  const { timeout = 12000, headers = {}, ...rest } = opts;
  return fetch(url, { ...rest, headers: { 'User-Agent': 'MLB-DFS-Tool/2.0', ...headers }, timeout });
}

const app = express();
const PORT = 3000;

// ── The Odds API Config ─────────────────────────────────────────────────────
const ODDS_API_KEY = process.env.ODDS_API_KEY;

// Full team name → abbreviation mapping for The Odds API
const TEAM_NAME_TO_ABBR = {
  'Arizona Diamondbacks': 'ARI', 'Atlanta Braves': 'ATL', 'Baltimore Orioles': 'BAL',
  'Boston Red Sox': 'BOS', 'Chicago Cubs': 'CHC', 'Chicago White Sox': 'CWS',
  'Cincinnati Reds': 'CIN', 'Cleveland Guardians': 'CLE', 'Colorado Rockies': 'COL',
  'Detroit Tigers': 'DET', 'Houston Astros': 'HOU', 'Kansas City Royals': 'KC',
  'Los Angeles Angels': 'LAA', 'Los Angeles Dodgers': 'LAD', 'Miami Marlins': 'MIA',
  'Milwaukee Brewers': 'MIL', 'Minnesota Twins': 'MIN', 'New York Mets': 'NYM',
  'New York Yankees': 'NYY', 'Oakland Athletics': 'OAK', 'Philadelphia Phillies': 'PHI',
  'Pittsburgh Pirates': 'PIT', 'San Diego Padres': 'SD', 'San Francisco Giants': 'SF',
  'Seattle Mariners': 'SEA', 'St. Louis Cardinals': 'STL', 'Tampa Bay Rays': 'TB',
  'Texas Rangers': 'TEX', 'Toronto Blue Jays': 'TOR', 'Washington Nationals': 'WSH',
  // Athletics rebrand
  'Athletics': 'OAK', 'Sacramento Athletics': 'OAK'
};

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Setup directories
const uploadDir = path.join(__dirname, 'uploads');
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.csv') cb(null, true);
    else cb(new Error('Only CSV files are allowed'), false);
  }
});

// ── File Upload Routes ──────────────────────────────────────────────────────

app.post('/api/upload', upload.array('files', 10), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }
  const files = req.files.map(file => ({
    originalName: file.originalname,
    storageName: file.filename,
    size: file.size,
    uploadedAt: new Date()
  }));
  res.json({ success: true, files, message: `${files.length} file(s) uploaded successfully` });
});

app.get('/api/files', (req, res) => {
  fs.readdir(uploadDir, (err, files) => {
    if (err) return res.status(500).json({ error: 'Failed to read files' });
    const fileList = files.map(file => {
      const fullPath = path.join(uploadDir, file);
      const stat = fs.statSync(fullPath);
      return { name: file, size: stat.size, uploadedAt: stat.mtime };
    });
    res.json({ files: fileList });
  });
});

app.delete('/api/files/:filename', (req, res) => {
  const filepath = path.join(uploadDir, req.params.filename);
  if (!filepath.startsWith(uploadDir)) return res.status(403).json({ error: 'Forbidden' });
  fs.unlink(filepath, (err) => {
    if (err) return res.status(500).json({ error: 'Failed to delete file' });
    res.json({ success: true });
  });
});

app.get('/api/files/:filename/content', (req, res) => {
  const filepath = path.join(uploadDir, req.params.filename);
  if (!filepath.startsWith(uploadDir)) return res.status(403).json({ error: 'Forbidden' });
  fs.readFile(filepath, 'utf8', (err, data) => {
    if (err) return res.status(500).json({ error: 'Failed to read file' });
    res.json({ content: data });
  });
});

// ── Weather API (free, no key required) ─────────────────────────────────────

app.get('/api/weather/:city', async (req, res) => {
  try {
    const city = encodeURIComponent(req.params.city);
    const response = await apiFetch(`https://wttr.in/${city}?format=j1`, { timeout: 8000 });
    if (!response.ok) throw new Error(`Weather API returned ${response.status}`);
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json') && !contentType.includes('text/json')) {
      throw new Error('Weather API returned non-JSON response');
    }
    const data = await response.json();
    if (!data.current_condition) throw new Error('Unexpected response format from weather API');
    const current = data.current_condition?.[0] || {};
    const hourly = data.weather?.[0]?.hourly || [];
    // Find game-time weather (afternoon ~1-4pm)
    const gameHour = hourly.find(h => parseInt(h.time) >= 1200 && parseInt(h.time) <= 1800) || hourly[2] || current;
    res.json({
      city: req.params.city,
      temp_f: parseInt(current.temp_F || gameHour.tempF || 72),
      feels_like_f: parseInt(current.FeelsLikeF || gameHour.FeelsLikeF || 72),
      humidity: parseInt(current.humidity || gameHour.humidity || 50),
      wind_mph: parseInt(current.windspeedMiles || gameHour.windspeedMiles || 5),
      wind_dir: current.winddir16Point || gameHour.winddir16Point || 'N',
      precip_chance: parseInt(gameHour.chanceofrain || current.chanceofrain || 0),
      condition: current.weatherDesc?.[0]?.value || 'Unknown',
      game_time: {
        temp_f: parseInt(gameHour.tempF || gameHour.temp_F || current.temp_F || 72),
        wind_mph: parseInt(gameHour.windspeedMiles || current.windspeedMiles || 5),
        wind_dir: gameHour.winddir16Point || current.winddir16Point || 'N',
        precip_chance: parseInt(gameHour.chanceofrain || 0)
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Weather fetch failed: ' + err.message });
  }
});

// Batch weather for multiple cities
app.post('/api/weather/batch', async (req, res) => {
  const { cities } = req.body;
  if (!cities || !Array.isArray(cities)) return res.status(400).json({ error: 'cities array required' });
  const results = {};
  const uniqueCities = [...new Set(cities)];
  await Promise.all(uniqueCities.map(async (city) => {
    try {
      const response = await apiFetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, { timeout: 8000 });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json') && !contentType.includes('text/json')) {
        throw new Error('non-JSON response from weather API');
      }
      const data = await response.json();
      if (!data.current_condition) throw new Error('unexpected weather API format');
      const current = data.current_condition?.[0] || {};
      const hourly = data.weather?.[0]?.hourly || [];
      const gameHour = hourly.find(h => parseInt(h.time) >= 1200 && parseInt(h.time) <= 1800) || hourly[2] || current;
      results[city] = {
        temp_f: parseInt(gameHour.tempF || current.temp_F || 72),
        wind_mph: parseInt(gameHour.windspeedMiles || current.windspeedMiles || 5),
        wind_dir: gameHour.winddir16Point || current.winddir16Point || 'N',
        precip_chance: parseInt(gameHour.chanceofrain || 0),
        humidity: parseInt(gameHour.humidity || current.humidity || 50),
        condition: current.weatherDesc?.[0]?.value || 'Unknown'
      };
    } catch (e) {
      results[city] = { error: e.message };
    }
  }));
  res.json(results);
});

// ── Vegas / Game Data Storage ───────────────────────────────────────────────

const vegasFile = path.join(dataDir, 'vegas.json');
let vegasWriteLock = false; // simple in-process mutex — prevents concurrent overwrites

app.get('/api/vegas', (req, res) => {
  try {
    if (fs.existsSync(vegasFile)) {
      const data = JSON.parse(fs.readFileSync(vegasFile, 'utf8'));
      res.json(data);
    } else {
      res.json({});
    }
  } catch (e) {
    res.json({});
  }
});

app.post('/api/vegas', (req, res) => {
  // Reject concurrent writes — the second caller retries from the client
  if (vegasWriteLock) {
    return res.status(409).json({ error: 'Vegas data is being updated — please retry in a moment.' });
  }
  vegasWriteLock = true;
  try {
    // Re-read the file inside the lock so we always merge against the latest state
    let existing = {};
    if (fs.existsSync(vegasFile)) {
      try { existing = JSON.parse(fs.readFileSync(vegasFile, 'utf8')); } catch (e) {}
    }
    const incoming = req.body;
    const merged = {};
    const allTeams = new Set([...Object.keys(existing), ...Object.keys(incoming)]);
    allTeams.forEach(team => {
      const prev = existing[team] || {};
      const curr = incoming[team] || {};
      merged[team] = { ...curr };
      // If we have a new implied total and an open line isn't set yet, snapshot it
      if (curr.impliedTotal != null) {
        merged[team].impliedTotal = curr.impliedTotal;
        if (prev.openTotal == null) {
          // First time saving — set open line to current
          merged[team].openTotal = curr.impliedTotal;
          merged[team].openAt = new Date().toISOString();
        } else {
          // Preserve the original open line
          merged[team].openTotal = prev.openTotal;
          merged[team].openAt = prev.openAt;
        }
      }
    });
    fs.writeFileSync(vegasFile, JSON.stringify(merged, null, 2));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save Vegas data' });
  } finally {
    vegasWriteLock = false;
  }
});

// ── Park Factors (static data, loaded once from JSON) ───────────────────────

const PARK_FACTORS = JSON.parse(fs.readFileSync(path.join(dataDir, 'park_factors.json'), 'utf8'));

app.get('/api/park-factors', (req, res) => {
  res.json(PARK_FACTORS);
});

app.get('/api/park-factors/:team', (req, res) => {
  const team = req.params.team.toUpperCase();
  res.json(PARK_FACTORS[team] || { overall: 1.00, hr: 1.00, run: 1.00 });
});

// ── Backtesting / Lineup History ────────────────────────────────────────────

const historyFile = path.join(dataDir, 'lineup_history.json');
const historySettingsFile = path.join(dataDir, 'history_settings.json');

function readHistory() {
  try {
    if (fs.existsSync(historyFile)) return JSON.parse(fs.readFileSync(historyFile, 'utf8'));
  } catch (e) {}
  return [];
}

function writeHistory(data) {
  fs.writeFileSync(historyFile, JSON.stringify(data, null, 2));
}

function readHistorySettings() {
  try {
    if (fs.existsSync(historySettingsFile)) return JSON.parse(fs.readFileSync(historySettingsFile, 'utf8'));
  } catch (e) {}
  return { maxSlates: 30, stripPoolAfterSlates: 5 };
}

function writeHistorySettings(s) {
  fs.writeFileSync(historySettingsFile, JSON.stringify(s, null, 2));
}

function pruneHistory(history, settings) {
  if (!history.length) return history;
  const { maxSlates, stripPoolAfterSlates } = settings;
  // Group by slateDate
  const slateDates = [...new Set(history.map(h => h.slateDate || ''))].sort().reverse();
  const keepDates = new Set(slateDates.slice(0, maxSlates));
  const stripDates = new Set(slateDates.slice(stripPoolAfterSlates));
  // Remove entries from dates beyond maxSlates
  let pruned = history.filter(h => keepDates.has(h.slateDate || ''));
  // Strip poolSnapshot from older entries to save space
  for (const entry of pruned) {
    if (stripDates.has(entry.slateDate || '') && entry.poolSnapshot && entry.poolSnapshot.length) {
      entry.poolSnapshot = [];
    }
  }
  return pruned;
}

app.get('/api/history/settings', (req, res) => {
  res.json(readHistorySettings());
});

app.put('/api/history/settings', (req, res) => {
  const maxSlates = Math.max(1, Math.min(365, parseInt(req.body.maxSlates) || 30));
  const stripPoolAfterSlates = Math.max(1, Math.min(maxSlates, parseInt(req.body.stripPoolAfterSlates) || 5));
  const settings = { maxSlates, stripPoolAfterSlates };
  writeHistorySettings(settings);
  // Apply pruning immediately with new settings
  let history = readHistory();
  history = pruneHistory(history, settings);
  writeHistory(history);
  res.json({ success: true, settings, entriesAfterPrune: history.length });
});

app.post('/api/history/prune', (req, res) => {
  const settings = readHistorySettings();
  let history = readHistory();
  const before = history.length;
  history = pruneHistory(history, settings);
  writeHistory(history);
  res.json({ success: true, before, after: history.length, removed: before - history.length });
});

app.get('/api/history', (req, res) => {
  res.json(readHistory());
});

app.post('/api/history', (req, res) => {
  let history = readHistory();
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    date: new Date().toISOString(),
    slateDate: req.body.slateDate || new Date().toISOString().substring(0, 10),
    slate: req.body.slate || 'Main',
    contest: req.body.contest || 'GPP',
    lineup: req.body.lineup || [],
    poolSnapshot: req.body.poolSnapshot || [],
    projectedPts: req.body.projectedPts || 0,
    projectedOwn: req.body.projectedOwn || 0,
    salary: req.body.salary || 0,
    actualPts: req.body.actualPts || null,
    playerActuals: req.body.playerActuals || null,
    finish: req.body.finish || null,
    entries: req.body.entries || null,
    winnings: req.body.winnings || null,
    buyin: req.body.buyin || null
  };
  history.unshift(entry);
  // Apply slate-based pruning
  const settings = readHistorySettings();
  history = pruneHistory(history, settings);
  writeHistory(history);
  res.json({ success: true, id: entry.id });
});

app.put('/api/history/:id', (req, res) => {
  const history = readHistory();
  const idx = history.findIndex(h => h.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  Object.assign(history[idx], req.body);
  writeHistory(history);
  res.json({ success: true });
});

app.delete('/api/history/:id', (req, res) => {
  let history = readHistory();
  history = history.filter(h => h.id !== req.params.id);
  writeHistory(history);
  res.json({ success: true });
});

// ROI summary
app.get('/api/history/summary', (req, res) => {
  const history = readHistory();
  const withResults = history.filter(h => h.actualPts !== null);
  const withFinancials = history.filter(h => h.winnings !== null && h.buyin !== null);

  const totalBuyin = withFinancials.reduce((s, h) => s + (h.buyin || 0), 0);
  const totalWinnings = withFinancials.reduce((s, h) => s + (h.winnings || 0), 0);
  const roi = totalBuyin > 0 ? ((totalWinnings - totalBuyin) / totalBuyin * 100) : 0;

  const avgProjected = withResults.length > 0
    ? withResults.reduce((s, h) => s + (h.projectedPts || 0), 0) / withResults.length : 0;
  const avgActual = withResults.length > 0
    ? withResults.reduce((s, h) => s + (h.actualPts || 0), 0) / withResults.length : 0;
  const projectionAccuracy = avgProjected > 0 ? (avgActual / avgProjected * 100) : 0;

  // By contest type
  const byContest = {};
  history.forEach(h => {
    if (!byContest[h.contest]) byContest[h.contest] = { count: 0, totalBuyin: 0, totalWinnings: 0, totalProjected: 0, totalActual: 0 };
    const c = byContest[h.contest];
    c.count++;
    if (h.buyin !== null) c.totalBuyin += h.buyin;
    if (h.winnings !== null) c.totalWinnings += h.winnings;
    if (h.projectedPts !== null) c.totalProjected += h.projectedPts;
    if (h.actualPts !== null) c.totalActual += h.actualPts;
  });

  const uniqueSlates = [...new Set(history.map(h => h.slateDate || ''))].length;
  const historySettings = readHistorySettings();

  res.json({
    totalEntries: history.length,
    entriesWithResults: withResults.length,
    uniqueSlates,
    historySettings,
    totalBuyin,
    totalWinnings,
    netProfit: totalWinnings - totalBuyin,
    roi,
    avgProjected,
    avgActual,
    projectionAccuracy,
    byContest
  });
});

// ── MLB Stats API — Actual Player DK Scores ─────────────────────────────────

const MLB_API_BASE = 'https://statsapi.mlb.com/api/v1';

// MLB Stats API team abbreviations that differ from DK
const MLB_TO_DK_ABBR = { 'AZ': 'ARI', 'WAS': 'WSH', 'ATH': 'OAK', 'SDP': 'SD', 'SFG': 'SF', 'TBR': 'TB', 'KCR': 'KC' };

function normalizeName(name) {
  return (name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip diacritics (é→e, ñ→n)
    .replace(/-/g, ' ')
    .replace(/\b(jr|sr|ii|iii|iv)\.?\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function ipToOuts(ipStr) {
  const parts = String(ipStr || '0').split('.');
  return parseInt(parts[0] || 0) * 3 + parseInt(parts[1] || 0);
}

function calcHitterDK(s) {
  const h = s.hits || 0, d = s.doubles || 0, t = s.triples || 0, hr = s.homeRuns || 0;
  const singles = Math.max(0, h - d - t - hr);
  return singles * 3 + d * 5 + t * 8 + hr * 10 +
    (s.rbi || 0) * 2 + (s.runs || 0) * 2 +
    (s.baseOnBalls || 0) * 2 + (s.hitByPitch || 0) * 2 +
    (s.stolenBases || 0) * 5 +
    (s.sacFlies || s.sacrificeFlies || 0) * 1.25;
}

function calcPitcherDK(s, isWin, gameInnings) {
  const outs = ipToOuts(s.inningsPitched);
  const totalGameOuts = (gameInnings || 9) * 3;
  const isCG = outs >= totalGameOuts;
  const isCGSO = isCG && (s.runs || 0) === 0;
  const isNH = isCG && (s.hits || 0) === 0;
  return outs * 0.75 +                          // 2.25 per IP = 0.75 per out
    (s.strikeOuts || 0) * 2 +
    (isWin ? 4 : 0) +
    (s.earnedRuns || 0) * -2 +
    (s.hits || 0) * -0.6 +
    (s.baseOnBalls || 0) * -0.6 +
    (s.hitBatsmen || 0) * -0.6 +
    (isCG ? 2.5 : 0) + (isCGSO ? 2.5 : 0) + (isNH ? 5 : 0);
}

async function fetchGameActuals(gamePk) {
  const boxRes = await apiFetch(`${MLB_API_BASE}/game/${gamePk}/boxscore`);
  if (!boxRes.ok) return null;
  const boxscore = await boxRes.json();

  const decisions = boxscore.decisions || {};
  const winnerNorm = normalizeName(decisions.winner?.fullName || '');
  const gameInnings = Math.max(
    boxscore.linescore?.scheduledInnings || 9,
    boxscore.linescore?.currentInning || 9
  );

  const scores = {};
  for (const side of ['home', 'away']) {
    const teamData = boxscore.teams?.[side];
    if (!teamData) continue;
    const rawAbbr = teamData.team?.abbreviation || '';
    const teamAbbr = MLB_TO_DK_ABBR[rawAbbr] || rawAbbr;

    for (const player of Object.values(teamData.players || {})) {
      const fullName = player.person?.fullName || '';
      if (!fullName) continue;
      const normName = normalizeName(fullName);
      const pos = player.position?.abbreviation || '';
      const isPitcher = pos === 'SP' || pos === 'RP' || pos === 'P';
      const batting = player.stats?.batting || {};
      const pitching = player.stats?.pitching || {};

      let dk = 0;
      const hasBatting = (batting.atBats || 0) > 0 || (batting.baseOnBalls || 0) > 0 || (batting.hitByPitch || 0) > 0;
      const hasPitching = parseFloat(pitching.inningsPitched || 0) > 0;

      if (!isPitcher && hasBatting) dk += calcHitterDK(batting);
      if (hasPitching) dk += calcPitcherDK(pitching, normName === winnerNorm, gameInnings);
      if (!isPitcher && isPitcher === false && hasBatting && hasPitching) {
        // two-way: already summed above
      }

      if (dk !== 0 || hasBatting || hasPitching) {
        if (!scores[normName]) {
          scores[normName] = { name: fullName, normName, team: teamAbbr, pos, dkScore: 0, gamePk };
        }
        scores[normName].dkScore = parseFloat((scores[normName].dkScore + dk).toFixed(2));
      }
    }
  }
  return scores;
}

// GET /api/actuals/:date — fetch actual DK scores for a slate date (YYYY-MM-DD)
app.get('/api/actuals/:date', async (req, res) => {
  try {
    const date = req.params.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });

    const schedRes = await apiFetch(`${MLB_API_BASE}/schedule?sportId=1&date=${date}&gameType=R`, { timeout: 15000 });
    if (!schedRes.ok) throw new Error(`MLB API returned ${schedRes.status}`);
    const schedule = await schedRes.json();
    const games = (schedule.dates?.[0]?.games || []).filter(g => g.status?.abstractGameState === 'Final');

    if (!games.length) {
      return res.json({ success: true, date, players: [], gameCount: 0, message: 'No final games found for this date' });
    }

    const allScores = {};
    await Promise.all(games.map(async (game) => {
      try {
        const scores = await fetchGameActuals(game.gamePk);
        if (scores) Object.assign(allScores, scores);
      } catch (e) { console.error(`Game ${game.gamePk} failed:`, e.message); }
    }));

    const players = Object.values(allScores).sort((a, b) => b.dkScore - a.dkScore);
    res.json({ success: true, date, players, gameCount: games.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch actuals: ' + err.message });
  }
});

// POST /api/actuals/apply — fetch actuals and auto-populate matching history entries
app.post('/api/actuals/apply', async (req, res) => {
  try {
    const { date } = req.body;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date (YYYY-MM-DD) required' });

    const schedRes = await apiFetch(`${MLB_API_BASE}/schedule?sportId=1&date=${date}&gameType=R`, { timeout: 15000 });
    if (!schedRes.ok) throw new Error(`MLB API returned ${schedRes.status}`);
    const schedule = await schedRes.json();
    const games = (schedule.dates?.[0]?.games || []).filter(g => g.status?.abstractGameState === 'Final');

    if (!games.length) {
      return res.json({ success: true, updated: 0, message: 'No final games found — games may still be in progress' });
    }

    const playerScores = {}; // normName → dkScore
    await Promise.all(games.map(async (game) => {
      try {
        const scores = await fetchGameActuals(game.gamePk);
        if (scores) {
          Object.entries(scores).forEach(([k, v]) => {
            playerScores[k] = (playerScores[k] || 0) + v.dkScore;
          });
        }
      } catch (e) { /* skip */ }
    }));

    if (!Object.keys(playerScores).length) {
      return res.json({ success: true, updated: 0, message: 'Could not retrieve player scores' });
    }

    // Match history entries for this date
    const history = readHistory();
    let updatedCount = 0;

    history.forEach(entry => {
      const entryDate = entry.slateDate || entry.date?.substring(0, 10);
      if (entryDate !== date) return;
      if (!Array.isArray(entry.lineup) || !entry.lineup.length) return;

      const playerActuals = {};
      let totalActual = 0;
      let matchCount = 0;

      for (const p of entry.lineup) {
        const normName = normalizeName(p.name);
        let score = playerScores[normName];

        // Fallback: first-initial + last-name match
        if (score === undefined) {
          const lastName = normName.split(' ').slice(-1)[0];
          const firstInit = normName.charAt(0);
          const key = Object.keys(playerScores).find(k => {
            const parts = k.split(' ');
            return parts.slice(-1)[0] === lastName && k.charAt(0) === firstInit;
          });
          if (key) score = playerScores[key];
        }

        if (score !== undefined) {
          playerActuals[p.name] = parseFloat(score.toFixed(2));
          totalActual += score;
          matchCount++;
        }
      }

      if (matchCount > 0) {
        entry.playerActuals = playerActuals;
        // Update lineup total if we matched at least 80% of players
        if (matchCount >= entry.lineup.length * 0.8) {
          entry.actualPts = parseFloat(totalActual.toFixed(2));
        }
        updatedCount++;
      }
    });

    writeHistory(history);
    res.json({ success: true, updated: updatedCount, playerCount: Object.keys(playerScores).length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to apply actuals: ' + err.message });
  }
});

// GET /api/history/analysis — projection accuracy statistics for model tuning
app.get('/api/history/analysis', (req, res) => {
  const history = readHistory();

  const pairs = [];
  history.forEach(entry => {
    if (!entry.playerActuals || !Array.isArray(entry.lineup)) return;
    entry.lineup.forEach(p => {
      const actual = entry.playerActuals[p.name];
      if (actual === undefined || actual === null) return;
      const projected = p.median || 0;
      if (projected <= 0) return;
      const isPitcher = (p.pos || '').includes('P');
      pairs.push({
        name: p.name, projected, actual,
        error: actual - projected,
        relError: (actual - projected) / projected,
        floor: p.floor || 0, ceiling: p.ceiling || 0,
        own: p.own || 0, order: p.order || 0,
        pos: isPitcher ? 'P' : 'BAT', team: p.team || ''
      });
    });
  });

  if (pairs.length < 5) {
    return res.json({ sampleSize: pairs.length, sufficient: false,
      message: `Need at least 5 player actuals. Currently have ${pairs.length}. Apply actuals from completed slates first.` });
  }

  function calcStats(arr) {
    if (!arr.length) return null;
    const n = arr.length;
    const bias = arr.reduce((s, p) => s + p.relError, 0) / n;
    const rmse = Math.sqrt(arr.reduce((s, p) => s + p.relError * p.relError, 0) / n);
    // Spearman rank correlation
    const sorted_p = [...arr].sort((a, b) => a.projected - b.projected);
    const sorted_a = [...arr].sort((a, b) => a.actual - b.actual);
    const pRank = new Array(n), aRank = new Array(n);
    sorted_p.forEach((item, rank) => { pRank[arr.indexOf(item)] = rank; });
    sorted_a.forEach((item, rank) => { aRank[arr.indexOf(item)] = rank; });
    let d2 = 0;
    for (let i = 0; i < n; i++) d2 += Math.pow(pRank[i] - aRank[i], 2);
    const spearman = n > 2 ? 1 - (6 * d2) / (n * (n * n - 1)) : 0;
    return {
      count: n,
      bias: parseFloat(bias.toFixed(4)),
      rmse: parseFloat(rmse.toFixed(4)),
      spearman: parseFloat(spearman.toFixed(4)),
      calibrationFactor: parseFloat((1 / (1 + bias)).toFixed(4))
    };
  }

  const pitchers = pairs.filter(p => p.pos === 'P');
  const batters = pairs.filter(p => p.pos === 'BAT');
  const overall = calcStats(pairs);
  const pitcherStats = calcStats(pitchers);
  const batterStats = calcStats(batters);

  const confidence = pairs.length >= 100 ? 'high' : pairs.length >= 40 ? 'medium' : pairs.length >= 20 ? 'low' : 'insufficient';

  res.json({
    sampleSize: pairs.length,
    sufficient: pairs.length >= 20,
    overall,
    pitchers: pitcherStats,
    batters: batterStats,
    topOrder: calcStats(batters.filter(p => p.order > 0 && p.order <= 3)),
    bottomOrder: calcStats(batters.filter(p => p.order >= 5)),
    highOwnership: calcStats(batters.filter(p => p.own > 25)),
    lowOwnership: calcStats(batters.filter(p => p.own > 0 && p.own <= 10)),
    suggestion: {
      pitcherCalibration: pitcherStats?.calibrationFactor ?? 1.0,
      batterCalibration: batterStats?.calibrationFactor ?? 1.0,
      confidence
    }
  });
});

// ── Calibration Storage ──────────────────────────────────────────────────────

const calibrationFile = path.join(dataDir, 'calibration.json');
const DEFAULT_CALIBRATION = { pitcherScale: 1.0, batterScale: 1.0, updatedAt: null };

app.get('/api/calibration', (req, res) => {
  try {
    res.json(fs.existsSync(calibrationFile) ? JSON.parse(fs.readFileSync(calibrationFile, 'utf8')) : DEFAULT_CALIBRATION);
  } catch (e) { res.json(DEFAULT_CALIBRATION); }
});

app.post('/api/calibration', (req, res) => {
  try {
    const cal = { ...DEFAULT_CALIBRATION, ...req.body, updatedAt: new Date().toISOString() };
    fs.writeFileSync(calibrationFile, JSON.stringify(cal, null, 2));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Failed to save calibration' }); }
});

// ── Stadium City Mapping (for weather lookups) ──────────────────────────────

const STADIUM_CITIES = {
  ARI: 'Phoenix', ATL: 'Atlanta', BAL: 'Baltimore', BOS: 'Boston',
  CHC: 'Chicago', CWS: 'Chicago', CIN: 'Cincinnati', CLE: 'Cleveland',
  COL: 'Denver', DET: 'Detroit', HOU: 'Houston', KC: 'Kansas City',
  LAA: 'Anaheim', LAD: 'Los Angeles', MIA: 'Miami', MIL: 'Milwaukee',
  MIN: 'Minneapolis', NYM: 'New York', NYY: 'New York', OAK: 'Oakland',
  PHI: 'Philadelphia', PIT: 'Pittsburgh', SD: 'San Diego', SF: 'San Francisco',
  SEA: 'Seattle', STL: 'St Louis', TB: 'St Petersburg', TEX: 'Arlington',
  TOR: 'Toronto', WSH: 'Washington'
};

// Dome/retractable roof stadiums (weather less impactful)
const DOME_STADIUMS = ['MIA', 'TB', 'TOR', 'MIL', 'ARI', 'HOU', 'TEX', 'SEA', 'MIN'];

app.get('/api/stadiums', (req, res) => {
  res.json({ cities: STADIUM_CITIES, domes: DOME_STADIUMS });
});

// ── Odds API — Fetch & Calculate Implied Team Totals ────────────────────────

app.get('/api/odds/fetch', async (req, res) => {
  if (!ODDS_API_KEY) {
    return res.status(503).json({ error: 'Odds API key not configured. Set the ODDS_API_KEY environment variable.' });
  }
  try {
    const url = `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds?regions=us&markets=h2h,totals&oddsFormat=american&apiKey=${ODDS_API_KEY}`;
    const response = await apiFetch(url);
    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Odds API returned ${response.status}: ${errBody}`);
    }
    const games = await response.json();
    const remaining = response.headers.get('x-requests-remaining');
    const used = response.headers.get('x-requests-used');

    const results = {};

    for (const game of games) {
      const homeAbbr = TEAM_NAME_TO_ABBR[game.home_team];
      const awayAbbr = TEAM_NAME_TO_ABBR[game.away_team];
      if (!homeAbbr || !awayAbbr) continue;

      // Use the first bookmaker that has both h2h and totals
      let h2h = null, totals = null;
      for (const bk of game.bookmakers || []) {
        const mkts = bk.markets || [];
        if (!h2h) h2h = mkts.find(m => m.key === 'h2h');
        if (!totals) totals = mkts.find(m => m.key === 'totals');
        if (h2h && totals) break;
      }

      if (!h2h || !totals) continue;

      // Extract moneylines
      const homeML = h2h.outcomes.find(o => o.name === game.home_team);
      const awayML = h2h.outcomes.find(o => o.name === game.away_team);
      const overLine = totals.outcomes.find(o => o.name === 'Over');
      if (!homeML || !awayML || !overLine) continue;

      const gameTotal = overLine.point;

      // Convert moneylines to implied probabilities
      const toProb = (ml) => ml < 0
        ? Math.abs(ml) / (Math.abs(ml) + 100)
        : 100 / (ml + 100);

      const homeProb = toProb(homeML.price);
      const awayProb = toProb(awayML.price);
      const sumProb = homeProb + awayProb;

      // Remove vig
      const homeNoVig = homeProb / sumProb;
      const awayNoVig = awayProb / sumProb;

      // Implied team totals
      const homeImplied = parseFloat((homeNoVig * gameTotal).toFixed(2));
      const awayImplied = parseFloat((awayNoVig * gameTotal).toFixed(2));

      results[homeAbbr] = {
        impliedTotal: homeImplied,
        gameTotal,
        moneyline: homeML.price,
        winProb: parseFloat((homeNoVig * 100).toFixed(1)),
        opponent: awayAbbr,
        home: true,
        commenceTime: game.commence_time
      };
      results[awayAbbr] = {
        impliedTotal: awayImplied,
        gameTotal,
        moneyline: awayML.price,
        winProb: parseFloat((awayNoVig * 100).toFixed(1)),
        opponent: homeAbbr,
        home: false,
        commenceTime: game.commence_time
      };
    }

    res.json({
      success: true,
      teams: results,
      gameCount: games.length,
      creditsRemaining: remaining,
      creditsUsed: used
    });
  } catch (err) {
    res.status(500).json({ error: 'Odds fetch failed: ' + err.message });
  }
});

// ── Confirmed Starting Lineups (MLB Stats API) ──────────────────────────────

const PARK_ORIENTATION = {
  // CF facing direction in degrees (0=N, 90=E, 180=S, 270=W)
  CHC: 45,   // Wrigley: CF faces NE
  BOS: 90,   // Fenway: CF faces roughly E
  NYY: 45,   // Yankee Stadium: CF faces NE
  NYM: 225,  // Citi Field: CF faces SW
  LAD: 315,  // Dodger Stadium: CF faces NW
  SFO: 270,  // Oracle Park: CF faces W
  SF: 270,
  COL: 315,  // Coors: CF faces NW
  TEX: 180,  // Globe Life: retractable
  MIN: 270,  // Target Field: CF faces W
  PHI: 180,  // Citizens Bank: CF faces S
  ATL: 225,  // Truist Park: CF faces SW
  BAL: 90,   // Camden Yards: CF faces E
  DET: 270,  // Comerica: CF faces W
  CLE: 180,  // Progressive Field: CF faces S
  PIT: 225,  // PNC Park: CF faces SW
  STL: 315,  // Busch Stadium: CF faces NW
  CIN: 270,  // GABP: CF faces W
  MIL: 270,  // American Family Field: retractable
  SEA: 315,  // T-Mobile Park: retractable
  KC: 180,   // Kauffman: CF faces S
  OAK: 270,  // Oakland: CF faces W
  SD: 315,   // Petco: CF faces NW
  LAA: 180,  // Angel Stadium: CF faces S
  WSH: 270,  // Nationals Park: CF faces W
  TB: 270,   // Tropicana: dome
  TOR: 270,  // Rogers: retractable
  MIA: 90,   // Marlins Park: dome
  HOU: 270,  // Minute Maid: retractable
  ARI: 90,   // Chase Field: retractable
};

// Update the stadiums endpoint to include orientation
app.get('/api/stadiums/extended', (req, res) => {
  res.json({ cities: STADIUM_CITIES, domes: DOME_STADIUMS, orientation: PARK_ORIENTATION });
});

// Wind direction string to degrees
function windDirToDeg(dir) {
  const map = { N:0, NNE:22.5, NE:45, ENE:67.5, E:90, ESE:112.5, SE:135, SSE:157.5,
    S:180, SSW:202.5, SW:225, WSW:247.5, W:270, WNW:292.5, NW:315, NNW:337.5 };
  return map[dir] !== undefined ? map[dir] : null;
}

// Compute wind effect: positive = blowing out, negative = blowing in
// Returns -1 to +1 scale
function calcWindEffect(windDir, windMph, parkTeam) {
  const parkAngle = PARK_ORIENTATION[parkTeam];
  if (!parkAngle || !windDir || windMph < 5) return 0;
  const windDeg = windDirToDeg(windDir);
  if (windDeg === null) return 0;
  const cfAngle = parkAngle;
  const outWindAngle = (cfAngle + 180) % 360;
  let diff = Math.abs(windDeg - outWindAngle);
  if (diff > 180) diff = 360 - diff;
  const effect = Math.cos(diff * Math.PI / 180);
  const strength = Math.min(windMph / 20, 1);
  return effect * strength;
}

app.get('/api/wind-effect/:team', async (req, res) => {
  const team = req.params.team.toUpperCase();
  const { wind_dir, wind_mph } = req.query;
  const effect = calcWindEffect(wind_dir, parseFloat(wind_mph) || 0, team);
  res.json({ team, wind_dir, wind_mph, effect, label: effect > 0.3 ? 'Blowing Out' : effect < -0.3 ? 'Blowing In' : 'Neutral' });
});

// ── Confirmed Starting Lineups ──────────────────────────────────────────────

app.get('/api/lineups/:date', async (req, res) => {
  try {
    const date = req.params.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });

    const schedRes = await apiFetch(`${MLB_API_BASE}/schedule?sportId=1&date=${date}&gameType=R&hydrate=probablePitcher(note)`);
    if (!schedRes.ok) throw new Error(`MLB API ${schedRes.status}`);
    const schedule = await schedRes.json();
    const games = schedule.dates?.[0]?.games || [];

    const results = await Promise.all(games.map(async (game) => {
      const gamePk = game.gamePk;
      const homeAbbr = MLB_TO_DK_ABBR[game.teams?.home?.team?.abbreviation] || game.teams?.home?.team?.abbreviation || '';
      const awayAbbr = MLB_TO_DK_ABBR[game.teams?.away?.team?.abbreviation] || game.teams?.away?.team?.abbreviation || '';
      const homeProbable = game.teams?.home?.probablePitcher?.fullName || null;
      const awayProbable = game.teams?.away?.probablePitcher?.fullName || null;
      const gameTime = game.gameDate || '';
      const status = game.status?.abstractGameState || 'Preview';

      let homeOrder = [], awayOrder = [], confirmed = false;

      if (status === 'Live' || status === 'Final' || status === 'Preview') {
        try {
          const liveRes = await apiFetch(`${MLB_API_BASE}/game/${gamePk}/linescore`, { timeout: 8000 });
          if (liveRes.ok) {
            if (status !== 'Preview') {
              const boxRes = await apiFetch(`${MLB_API_BASE}/game/${gamePk}/boxscore`, { timeout: 10000 });
              if (boxRes.ok) {
                const box = await boxRes.json();
                const extractOrder = (teamData) => {
                  if (!teamData?.battingOrder) return [];
                  return teamData.battingOrder.map(id => {
                    const p = teamData.players?.['ID' + id];
                    return p?.person?.fullName || '';
                  }).filter(Boolean);
                };
                homeOrder = extractOrder(box.teams?.home);
                awayOrder = extractOrder(box.teams?.away);
                confirmed = homeOrder.length > 0 || awayOrder.length > 0;
              }
            }
          }
        } catch (e) { /* live data unavailable */ }
      }

      return {
        gamePk, homeTeam: homeAbbr, awayTeam: awayAbbr,
        homeProbable, awayProbable, gameTime, status,
        homeOrder, awayOrder, confirmed
      };
    }));

    res.json({ success: true, date, games: results });
  } catch (err) {
    res.status(500).json({ error: 'Lineup fetch failed: ' + err.message });
  }
});

// ── Statcast Data (Baseball Savant) ────────────────────────────────────────

const statcastCacheFile = path.join(dataDir, 'statcast_cache.json');

async function fetchStatcastLeaderboard() {
  const year = new Date().getFullYear();
  const url = `https://baseballsavant.mlb.com/leaderboard/custom?year=${year}&type=batter&filter=&sort=4&sortDir=desc&min=q&selections=xba,xslg,xwoba,exit_velocity_avg,launch_angle_avg,barrel_batted_rate,hard_hit_percent&chart=false&x=xba&y=xba&r=no&chartType=beeswarm&csv=true`;
  const resp = await apiFetch(url, { timeout: 20000, headers: { Accept: 'text/csv' } });
  if (!resp.ok) throw new Error(`Savant returned ${resp.status}`);
  const text = await resp.text();
  const lines = text.trim().split('\n');
  if (lines.length < 2) throw new Error('Empty Statcast response');
  const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim().toLowerCase());
  const data = {};
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',').map(v => v.replace(/"/g, '').trim());
    const row = {};
    headers.forEach((h, j) => row[h] = vals[j] || '');
    const name = row['last_name, first_name'] || row['player_name'] || '';
    if (!name) continue;
    const parts = name.split(',');
    const normalized = parts.length === 2 ? (parts[1].trim() + ' ' + parts[0].trim()) : name;
    data[normalized.toLowerCase()] = {
      barrelRate: parseFloat(row['barrel_batted_rate'] || row['brl_percent'] || 0) || 0,
      hardHitRate: parseFloat(row['hard_hit_percent'] || 0) || 0,
      exitVelo: parseFloat(row['exit_velocity_avg'] || 0) || 0,
      launchAngle: parseFloat(row['launch_angle_avg'] || 0) || 0,
      xwOBA: parseFloat(row['xwoba'] || 0) || 0,
      xSLG: parseFloat(row['xslg'] || 0) || 0,
    };
  }
  return data;
}

app.get('/api/statcast', async (req, res) => {
  try {
    if (fs.existsSync(statcastCacheFile)) {
      const cached = JSON.parse(fs.readFileSync(statcastCacheFile, 'utf8'));
      const age = Date.now() - new Date(cached.fetchedAt).getTime();
      if (age < 12 * 60 * 60 * 1000) {
        return res.json({ success: true, data: cached.data, cached: true, fetchedAt: cached.fetchedAt });
      }
    }
    const data = await fetchStatcastLeaderboard();
    const payload = { data, fetchedAt: new Date().toISOString(), count: Object.keys(data).length };
    fs.writeFileSync(statcastCacheFile, JSON.stringify(payload, null, 2));
    res.json({ success: true, ...payload });
  } catch (err) {
    if (fs.existsSync(statcastCacheFile)) {
      const cached = JSON.parse(fs.readFileSync(statcastCacheFile, 'utf8'));
      return res.json({ success: true, data: cached.data, cached: true, stale: true, fetchedAt: cached.fetchedAt, error: err.message });
    }
    res.status(500).json({ error: 'Statcast fetch failed: ' + err.message });
  }
});

// ── Pitcher Statcast Data (Baseball Savant) ────────────────────────────────

const pitcherStatcastCacheFile = path.join(dataDir, 'pitcher_statcast_cache.json');

async function fetchPitcherStatcastLeaderboard() {
  const year = new Date().getFullYear();
  const url = `https://baseballsavant.mlb.com/leaderboard/custom?year=${year}&type=pitcher&filter=&sort=4&sortDir=desc&min=q&selections=p_k_percent,p_bb_percent,whiff_percent,fastball_avg_speed,hard_hit_percent,xera,xba&chart=false&x=xba&y=xba&r=no&chartType=beeswarm&csv=true`;
  const resp = await apiFetch(url, { timeout: 20000, headers: { Accept: 'text/csv' } });
  if (!resp.ok) throw new Error(`Savant returned ${resp.status}`);
  const text = await resp.text();
  const lines = text.trim().split('\n');
  if (lines.length < 2) throw new Error('Empty pitcher Statcast response');
  const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim().toLowerCase());
  const data = {};
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',').map(v => v.replace(/"/g, '').trim());
    const row = {};
    headers.forEach((h, j) => row[h] = vals[j] || '');
    const name = row['last_name, first_name'] || row['player_name'] || '';
    if (!name) continue;
    const parts = name.split(',');
    const normalized = parts.length === 2 ? (parts[1].trim() + ' ' + parts[0].trim()) : name;
    data[normalized.toLowerCase()] = {
      kPercent: parseFloat(row['p_k_percent'] || 0) || 0,
      bbPercent: parseFloat(row['p_bb_percent'] || 0) || 0,
      whiffRate: parseFloat(row['whiff_percent'] || 0) || 0,
      fastballVelo: parseFloat(row['fastball_avg_speed'] || 0) || 0,
      hardHitRate: parseFloat(row['hard_hit_percent'] || 0) || 0,
      xERA: parseFloat(row['xera'] || 0) || 0,
      xBA: parseFloat(row['xba'] || 0) || 0,
    };
  }
  return data;
}

app.get('/api/statcast/pitchers', async (req, res) => {
  try {
    if (fs.existsSync(pitcherStatcastCacheFile)) {
      const cached = JSON.parse(fs.readFileSync(pitcherStatcastCacheFile, 'utf8'));
      const age = Date.now() - new Date(cached.fetchedAt).getTime();
      if (age < 12 * 60 * 60 * 1000) {
        return res.json({ success: true, data: cached.data, cached: true, fetchedAt: cached.fetchedAt });
      }
    }
    const data = await fetchPitcherStatcastLeaderboard();
    const payload = { data, fetchedAt: new Date().toISOString(), count: Object.keys(data).length };
    fs.writeFileSync(pitcherStatcastCacheFile, JSON.stringify(payload, null, 2));
    res.json({ success: true, ...payload });
  } catch (err) {
    if (fs.existsSync(pitcherStatcastCacheFile)) {
      const cached = JSON.parse(fs.readFileSync(pitcherStatcastCacheFile, 'utf8'));
      return res.json({ success: true, data: cached.data, cached: true, stale: true, fetchedAt: cached.fetchedAt, error: err.message });
    }
    res.status(500).json({ error: 'Pitcher Statcast fetch failed: ' + err.message });
  }
});

// ── Bullpen Quality Rankings (MLB Stats API) ─────────────────────────────────

const bullpenCacheFile = path.join(dataDir, 'bullpen_cache.json');

async function fetchBullpenStats() {
  const year = new Date().getFullYear();
  const url = `https://statsapi.mlb.com/api/v1/teams/stats?stats=season&group=pitching&season=${year}&sportIds=1&sitCodes=rp&fields=stats,splits,stat,era,whip,strikeoutsPer9Inn,walksPer9Inn,homeRunsPer9Inn,inningsPitched,saves,blownSaves,team,name,id`;
  const resp = await apiFetch(url, { timeout: 15000 });
  if (!resp.ok) throw new Error(`MLB API returned ${resp.status}`);
  const json = await resp.json();
  const splits = json.stats?.[0]?.splits || [];
  if (!splits.length) throw new Error('Empty bullpen response');

  const data = {};
  splits.forEach(s => {
    const teamName = s.team?.name || '';
    const abbr = TEAM_NAME_TO_ABBR[teamName];
    if (!abbr) return;
    const st = s.stat || {};
    data[abbr] = {
      era: parseFloat(st.era) || 4.50,
      whip: parseFloat(st.whip) || 1.30,
      kPer9: parseFloat(st.strikeoutsPer9Inn) || 8.50,
      bbPer9: parseFloat(st.walksPer9Inn) || 3.50,
      hrPer9: parseFloat(st.homeRunsPer9Inn) || 1.20,
      ip: parseFloat(st.inningsPitched) || 0,
      saves: parseInt(st.saves) || 0,
      blownSaves: parseInt(st.blownSaves) || 0,
    };
  });
  return data;
}

app.get('/api/bullpen', async (req, res) => {
  try {
    if (fs.existsSync(bullpenCacheFile)) {
      const cached = JSON.parse(fs.readFileSync(bullpenCacheFile, 'utf8'));
      const age = Date.now() - new Date(cached.fetchedAt).getTime();
      if (age < 12 * 60 * 60 * 1000) {
        return res.json({ success: true, data: cached.data, cached: true, fetchedAt: cached.fetchedAt });
      }
    }
    const data = await fetchBullpenStats();
    const payload = { data, fetchedAt: new Date().toISOString(), count: Object.keys(data).length };
    fs.writeFileSync(bullpenCacheFile, JSON.stringify(payload, null, 2));
    res.json({ success: true, ...payload });
  } catch (err) {
    if (fs.existsSync(bullpenCacheFile)) {
      const cached = JSON.parse(fs.readFileSync(bullpenCacheFile, 'utf8'));
      return res.json({ success: true, data: cached.data, cached: true, stale: true, fetchedAt: cached.fetchedAt, error: err.message });
    }
    res.status(500).json({ error: 'Bullpen fetch failed: ' + err.message });
  }
});

// ── Catcher Framing (Baseball Savant) ────────────────────────────────────────

const framingCacheFile = path.join(dataDir, 'framing_cache.json');

async function fetchCatcherFraming() {
  // Use 2025 full-season data for robust sample sizes (2026 too early in season)
  const url = 'https://baseballsavant.mlb.com/leaderboard/catcher-framing?type=catcher&seasonStart=2025&seasonEnd=2025&team=&min=q&sortColumn=rv_tot&sortDirection=desc&csv=true';
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  });
  if (!resp.ok) throw new Error(`Savant framing HTTP ${resp.status}`);
  const text = await resp.text();
  const lines = text.trim().split('\n');
  if (lines.length < 2) throw new Error('Empty framing CSV');
  const header = lines[0].replace(/"/g, '').split(',');
  const nameIdx = header.indexOf('name');
  const rvIdx = header.indexOf('rv_tot');
  const pctIdx = header.indexOf('pct_tot');
  const pitchesIdx = header.indexOf('pitches');
  if (nameIdx < 0 || rvIdx < 0) throw new Error('Missing framing CSV columns');

  const data = {};
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].replace(/"/g, '').split(',');
    const rawName = vals[nameIdx] || '';
    // CSV has "Last, First" — convert to "First Last"
    const parts = rawName.split(',').map(s => s.trim());
    const displayName = parts.length >= 2 ? `${parts[1]} ${parts[0]}` : rawName;
    const key = displayName.toLowerCase().replace(/[^a-z ]/g, '').trim();
    if (!key) continue;

    const framingRuns = parseFloat(vals[rvIdx]) || 0;
    const shadowStrikePct = parseFloat(vals[pctIdx]) || 0;
    const pitches = parseInt(vals[pitchesIdx]) || 0;
    // Normalize to per-game rate (~140 pitches per catcher game)
    const gamesEst = pitches / 140;
    const framingRunsPerGame = gamesEst > 0 ? framingRuns / gamesEst : 0;

    data[key] = { name: displayName, framingRuns, framingRunsPerGame, shadowStrikePct, pitches };
  }
  return data;
}

app.get('/api/framing', async (req, res) => {
  try {
    if (fs.existsSync(framingCacheFile)) {
      const cached = JSON.parse(fs.readFileSync(framingCacheFile, 'utf8'));
      const age = Date.now() - new Date(cached.fetchedAt).getTime();
      if (age < 12 * 60 * 60 * 1000) {
        return res.json({ success: true, data: cached.data, cached: true, fetchedAt: cached.fetchedAt, count: cached.count });
      }
    }
    const data = await fetchCatcherFraming();
    const payload = { data, fetchedAt: new Date().toISOString(), count: Object.keys(data).length };
    fs.writeFileSync(framingCacheFile, JSON.stringify(payload, null, 2));
    res.json({ success: true, ...payload });
  } catch (err) {
    if (fs.existsSync(framingCacheFile)) {
      const cached = JSON.parse(fs.readFileSync(framingCacheFile, 'utf8'));
      return res.json({ success: true, data: cached.data, cached: true, stale: true, fetchedAt: cached.fetchedAt, count: cached.count, error: err.message });
    }
    res.status(500).json({ error: 'Framing fetch failed: ' + err.message });
  }
});

// ── Sprint Speed (Baseball Savant) ───────────────────────────────────────────

const sprintCacheFile = path.join(dataDir, 'sprint_cache.json');

async function fetchSprintSpeed() {
  // Use 2025 full-season for reliable sample; 2026 has limited data early in season
  const url = 'https://baseballsavant.mlb.com/leaderboard/sprint_speed?min_season=2025&max_season=2025&position=&team=&min=10&csv=true';
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  });
  if (!resp.ok) throw new Error(`Savant sprint HTTP ${resp.status}`);
  const text = await resp.text();
  const lines = text.trim().split('\n');
  if (lines.length < 2) throw new Error('Empty sprint CSV');
  const header = lines[0].replace(/"/g, '').split(',');
  const nameIdx = header.findIndex(h => h.trim() === 'last_name, first_name');
  const speedIdx = header.findIndex(h => h.trim() === 'sprint_speed');
  const boltsIdx = header.findIndex(h => h.trim() === 'bolts');
  const hpIdx = header.findIndex(h => h.trim() === 'hp_to_1b');
  if (nameIdx < 0 || speedIdx < 0) throw new Error('Missing sprint CSV columns');

  const data = {};
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].replace(/"/g, '').split(',');
    const rawName = vals[nameIdx] || '';
    // CSV has "Last, First" — convert to "First Last"
    const parts = rawName.split(',').map(s => s.trim());
    const displayName = parts.length >= 2 ? `${parts[1]} ${parts[0]}` : rawName;
    const key = displayName.toLowerCase().replace(/[^a-z ]/g, '').trim();
    if (!key) continue;

    data[key] = {
      name: displayName,
      sprintSpeed: parseFloat(vals[speedIdx]) || 0,
      bolts: parseInt(vals[boltsIdx]) || 0,
      hpTo1b: parseFloat(vals[hpIdx]) || 0
    };
  }
  return data;
}

app.get('/api/sprint-speed', async (req, res) => {
  try {
    if (fs.existsSync(sprintCacheFile)) {
      const cached = JSON.parse(fs.readFileSync(sprintCacheFile, 'utf8'));
      const age = Date.now() - new Date(cached.fetchedAt).getTime();
      if (age < 24 * 60 * 60 * 1000) {
        return res.json({ success: true, data: cached.data, cached: true, fetchedAt: cached.fetchedAt, count: cached.count });
      }
    }
    const data = await fetchSprintSpeed();
    const payload = { data, fetchedAt: new Date().toISOString(), count: Object.keys(data).length };
    fs.writeFileSync(sprintCacheFile, JSON.stringify(payload, null, 2));
    res.json({ success: true, ...payload });
  } catch (err) {
    if (fs.existsSync(sprintCacheFile)) {
      const cached = JSON.parse(fs.readFileSync(sprintCacheFile, 'utf8'));
      return res.json({ success: true, data: cached.data, cached: true, stale: true, fetchedAt: cached.fetchedAt, count: cached.count, error: err.message });
    }
    res.status(500).json({ error: 'Sprint speed fetch failed: ' + err.message });
  }
});

// ── Recent Form (last 14 days from MLB Stats API) ────────────────────────────

const formCacheFile = path.join(dataDir, 'form_cache.json');

app.get('/api/form', async (req, res) => {
  try {
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - 14 * 24 * 60 * 60 * 1000);
    const fmt = d => d.toISOString().substring(0, 10);
    const cacheKey = fmt(startDate) + '_' + fmt(endDate);

    if (fs.existsSync(formCacheFile)) {
      const cached = JSON.parse(fs.readFileSync(formCacheFile, 'utf8'));
      const age = Date.now() - new Date(cached.fetchedAt).getTime();
      if (age < 4 * 60 * 60 * 1000 && cached.cacheKey === cacheKey) {
        return res.json({ success: true, data: cached.data, cached: true });
      }
    }

    const schedRes = await apiFetch(
      `${MLB_API_BASE}/schedule?sportId=1&startDate=${fmt(startDate)}&endDate=${fmt(endDate)}&gameType=R`,
      { timeout: 15000 }
    );
    if (!schedRes.ok) throw new Error(`MLB schedule API ${schedRes.status}`);
    const schedule = await schedRes.json();

    const allGames = [];
    (schedule.dates || []).forEach(d => { (d.games || []).forEach(g => { if (g.status?.abstractGameState === 'Final') allGames.push(g.gamePk); }); });

    if (!allGames.length) return res.json({ success: true, data: {}, message: 'No completed games in window' });

    const playerAgg = {};

    const chunk = (arr, size) => { const r = []; for (let i = 0; i < arr.length; i += size) r.push(arr.slice(i, i + size)); return r; };
    for (const batch of chunk(allGames.slice(0, 60), 8)) {
      await Promise.all(batch.map(async (gamePk) => {
        try {
          const br = await apiFetch(`${MLB_API_BASE}/game/${gamePk}/boxscore`, { timeout: 10000 });
          if (!br.ok) return;
          const box = await br.json();
          const decisions = box.decisions || {};
          const winnerNorm = normalizeName(decisions.winner?.fullName || '');
          const gameInnings = Math.max(box.linescore?.scheduledInnings || 9, box.linescore?.currentInning || 9);
          for (const side of ['home', 'away']) {
            const teamData = box.teams?.[side];
            if (!teamData) continue;
            const rawAbbr = teamData.team?.abbreviation || '';
            const teamAbbr = MLB_TO_DK_ABBR[rawAbbr] || rawAbbr;
            for (const player of Object.values(teamData.players || {})) {
              const fullName = player.person?.fullName || '';
              if (!fullName) continue;
              const normName = normalizeName(fullName);
              const pos = player.position?.abbreviation || '';
              const isPitcher = pos === 'SP' || pos === 'RP' || pos === 'P';
              const batting = player.stats?.batting || {};
              const pitching = player.stats?.pitching || {};
              const hasBatting = (batting.atBats || 0) > 0 || (batting.baseOnBalls || 0) > 0;
              const hasPitching = parseFloat(pitching.inningsPitched || 0) > 0;
              if (!hasBatting && !hasPitching) continue;
              if (!playerAgg[normName]) {
                playerAgg[normName] = { name: fullName, team: teamAbbr, isPitcher, games: 0,
                  ab: 0, h: 0, hr: 0, k: 0, bb: 0, rbi: 0, runs: 0, sb: 0,
                  outs: 0, er: 0, pitchK: 0, pitchBB: 0, pitchH: 0, wins: 0, dkTotal: 0 };
              }
              const agg = playerAgg[normName];
              agg.games++;
              if (hasBatting) {
                agg.ab += batting.atBats || 0;
                agg.h += batting.hits || 0;
                agg.hr += batting.homeRuns || 0;
                agg.k += batting.strikeOuts || 0;
                agg.bb += batting.baseOnBalls || 0;
                agg.rbi += batting.rbi || 0;
                agg.runs += batting.runs || 0;
                agg.sb += batting.stolenBases || 0;
                agg.dkTotal += calcHitterDK(batting);
              }
              if (hasPitching) {
                agg.outs += ipToOuts(pitching.inningsPitched);
                agg.er += pitching.earnedRuns || 0;
                agg.pitchK += pitching.strikeOuts || 0;
                agg.pitchBB += pitching.baseOnBalls || 0;
                agg.pitchH += pitching.hits || 0;
                if (normName === winnerNorm) agg.wins++;
                agg.dkTotal += calcPitcherDK(pitching, normName === winnerNorm, gameInnings);
              }
            }
          }
        } catch (e) { /* skip failed games */ }
      }));
    }

    const data = {};
    for (const [normName, agg] of Object.entries(playerAgg)) {
      if (agg.games < 2) continue;
      const ba = agg.ab > 0 ? agg.h / agg.ab : 0;
      const kPer9 = agg.outs > 0 ? (agg.pitchK / (agg.outs / 3)) * 9 : 0;
      const era = agg.outs > 0 ? (agg.er / (agg.outs / 3)) * 9 : 0;
      data[normName] = {
        name: agg.name, team: agg.team, isPitcher: agg.isPitcher,
        games: agg.games, avgDK: parseFloat((agg.dkTotal / agg.games).toFixed(2)),
        ba: parseFloat(ba.toFixed(3)), hr: agg.hr, sb: agg.sb,
        kPer9: parseFloat(kPer9.toFixed(1)), era: parseFloat(era.toFixed(2)),
        whip: agg.outs > 0 ? parseFloat(((agg.pitchBB + agg.pitchH) / (agg.outs / 3)).toFixed(2)) : null
      };
    }

    const payload = { data, fetchedAt: new Date().toISOString(), cacheKey, playerCount: Object.keys(data).length };
    fs.writeFileSync(formCacheFile, JSON.stringify(payload, null, 2));
    res.json({ success: true, ...payload });
  } catch (err) {
    if (fs.existsSync(formCacheFile)) {
      const cached = JSON.parse(fs.readFileSync(formCacheFile, 'utf8'));
      return res.json({ success: true, data: cached.data, cached: true, stale: true, error: err.message });
    }
    res.status(500).json({ error: 'Form fetch failed: ' + err.message });
  }
});

// ── Injury / Transaction Feed (MLB Stats API) ──────────────────────────────

// Transaction types that flag a player as unavailable or at-risk
const IL_KEYWORDS = ['placed on', '10-day il', '15-day il', '60-day il', 'transferred to', 'traded', 'released', 'designated for assignment', 'dfa'];
const GTOD_KEYWORDS = ['day-to-day', 'dtd', 'game-time decision'];

app.get('/api/injuries', async (req, res) => {
  try {
    const end = new Date();
    const start = new Date(end.getTime() - 48 * 60 * 60 * 1000);
    const fmt = d => d.toISOString().substring(0, 10);

    const txRes = await apiFetch(
      `${MLB_API_BASE}/transactions?startDate=${fmt(start)}&endDate=${fmt(end)}&sportId=1`,
      { headers: { Accept: 'application/json' } }
    );
    if (!txRes.ok) throw new Error(`MLB API returned ${txRes.status}`);
    const contentType = txRes.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      // API returned HTML (Cloudflare block, maintenance page, etc.) — fail gracefully
      return res.json({ success: true, flagged: [], total: 0, window: '48h', note: 'Injury feed unavailable (MLB API returned non-JSON response)' });
    }
    const txData = await txRes.json();

    const transactions = txData.transactions || [];
    const flagged = [];

    for (const tx of transactions) {
      const desc = (tx.description || tx.typeDesc || '').toLowerCase();
      const isIL = IL_KEYWORDS.some(kw => desc.includes(kw));
      const isGTOD = GTOD_KEYWORDS.some(kw => desc.includes(kw));
      if (!isIL && !isGTOD) continue;

      const playerName = tx.person?.fullName || '';
      if (!playerName) continue;

      const rawTeam = tx.toTeam?.abbreviation || tx.fromTeam?.abbreviation || '';
      const team = MLB_TO_DK_ABBR[rawTeam] || rawTeam;
      const txDate = tx.date || tx.effectiveDate || '';

      flagged.push({
        name: playerName,
        team,
        type: isGTOD ? 'GTD' : 'IL',
        description: tx.description || tx.typeDesc || '',
        date: txDate
      });
    }

    // Dedupe by player name (keep most recent)
    const seen = new Map();
    for (const f of flagged) {
      const existing = seen.get(f.name.toLowerCase());
      if (!existing || f.date > existing.date) seen.set(f.name.toLowerCase(), f);
    }

    res.json({ success: true, flagged: [...seen.values()], total: seen.size, window: '48h' });
  } catch (err) {
    res.status(500).json({ error: 'Injury fetch failed: ' + err.message });
  }
});

// ── Umpire Data ─────────────────────────────────────────────────────────────

// Tendency score: positive = pitcher-friendly (tight zone, more Ks)
//                 negative = batter-friendly (generous zone, more BBs/contact)
// Scale: roughly -1.0 to +1.0
// Source: THE BAT context-neutral projected 'true talent' ERA (EV Analytics, April 2026)
// Mapping: score ≈ (4.05 - era) * 8, k ≈ score * 0.5, bb ≈ -score * 0.3
// Lower ERA = pitcher-friendly zone (positive score)
// Higher ERA = hitter-friendly zone (negative score)
const UMPIRE_DB = {
  // ── Extreme Pitchers (ERA ≤ 3.97) ──
  'Mike Estabrook':      { era: 3.92, k: 0.5,  bb: -0.3, score: 1.0  },
  'Phil Cuzzi':          { era: 3.93, k: 0.5,  bb: -0.3, score: 1.0  },
  'Bill Miller':         { era: 3.95, k: 0.4,  bb: -0.2, score: 0.8  },
  'Ron Kulpa':           { era: 3.95, k: 0.4,  bb: -0.2, score: 0.8  },
  'Doug Eddings':        { era: 3.95, k: 0.4,  bb: -0.2, score: 0.8  },
  'Alex MacKay':         { era: 3.97, k: 0.3,  bb: -0.2, score: 0.6  },
  'Ryan Blakney':        { era: 3.97, k: 0.3,  bb: -0.2, score: 0.6  },
  // ── Pitchers (ERA 3.99–4.03) ──
  'Adam Hamari':         { era: 3.99, k: 0.3,  bb: -0.2, score: 0.5  },
  'Nestor Ceja':         { era: 3.99, k: 0.3,  bb: -0.2, score: 0.5  },
  'Vic Carapazza':       { era: 3.99, k: 0.3,  bb: -0.2, score: 0.5  },
  'CB Bucknor':          { era: 3.99, k: 0.3,  bb: -0.2, score: 0.5  },
  'Jeremie Rehak':       { era: 3.99, k: 0.3,  bb: -0.2, score: 0.5  },
  'Dexter Kelley':       { era: 4.00, k: 0.2,  bb: -0.1, score: 0.4  },
  'Dan Merzel':          { era: 4.00, k: 0.2,  bb: -0.1, score: 0.4  },
  'Edwin Jimenez':       { era: 4.00, k: 0.2,  bb: -0.1, score: 0.4  },
  'Emil Jimenez':        { era: 4.00, k: 0.2,  bb: -0.1, score: 0.4  },
  'Gabe Morales':        { era: 4.00, k: 0.2,  bb: -0.1, score: 0.4  },
  'Brennan Miller':      { era: 4.00, k: 0.2,  bb: -0.1, score: 0.4  },
  'Paul Clemons':        { era: 4.00, k: 0.2,  bb: -0.1, score: 0.4  },
  'Nick Mahrley':        { era: 4.01, k: 0.2,  bb: -0.1, score: 0.3  },
  'Tom Hanahan':         { era: 4.01, k: 0.2,  bb: -0.1, score: 0.3  },
  'Cory Blaser':         { era: 4.01, k: 0.2,  bb: -0.1, score: 0.3  },
  'Junior Valentine':    { era: 4.02, k: 0.1,  bb: -0.1, score: 0.2  },
  'Austin Jones':        { era: 4.02, k: 0.1,  bb: -0.1, score: 0.2  },
  'David Rackley':       { era: 4.02, k: 0.1,  bb: -0.1, score: 0.2  },
  'Tony Randazzo':       { era: 4.02, k: 0.1,  bb: -0.1, score: 0.2  },
  'Rob Drake':           { era: 4.02, k: 0.1,  bb: -0.1, score: 0.2  },
  'Steven Jaschinski':   { era: 4.03, k: 0.1,  bb: -0.1, score: 0.2  },
  'Jim Wolf':            { era: 4.03, k: 0.1,  bb: -0.1, score: 0.2  },
  'Adam Beck':           { era: 4.03, k: 0.1,  bb: -0.1, score: 0.2  },
  'Roberto Ortiz':       { era: 4.03, k: 0.1,  bb: -0.1, score: 0.2  },
  'Chris Conroy':        { era: 4.03, k: 0.1,  bb: -0.1, score: 0.2  },
  // ── Neutral (ERA 4.04–4.07) ──
  'Chris Segal':         { era: 4.04, k: 0.1,  bb: 0.0,  score: 0.1  },
  'John Tumpane':        { era: 4.04, k: 0.1,  bb: 0.0,  score: 0.1  },
  'Nate Tomlinson':      { era: 4.04, k: 0.1,  bb: 0.0,  score: 0.1  },
  'D.J. Reyburn':        { era: 4.04, k: 0.1,  bb: 0.0,  score: 0.1  },
  'Brian O\'Nora':       { era: 4.04, k: 0.1,  bb: 0.0,  score: 0.1  },
  'Jeremy Riggs':        { era: 4.04, k: 0.1,  bb: 0.0,  score: 0.1  },
  'Lance Barrett':       { era: 4.04, k: 0.1,  bb: 0.0,  score: 0.1  },
  'Brian Walsh':         { era: 4.04, k: 0.1,  bb: 0.0,  score: 0.1  },
  'Laz Diaz':            { era: 4.04, k: 0.1,  bb: 0.0,  score: 0.1  },
  'Brock Ballou':        { era: 4.05, k: 0.0,  bb: 0.0,  score: 0.0  },
  'Jacob Metz':          { era: 4.05, k: 0.0,  bb: 0.0,  score: 0.0  },
  'Malachi Moore':       { era: 4.06, k: 0.0,  bb: 0.0,  score: -0.1 },
  'Ryan Additon':        { era: 4.06, k: 0.0,  bb: 0.0,  score: -0.1 },
  'Will Little':         { era: 4.06, k: 0.0,  bb: 0.0,  score: -0.1 },
  'Chad Whitson':        { era: 4.06, k: 0.0,  bb: 0.0,  score: -0.1 },
  'Alex Tosi':           { era: 4.06, k: 0.0,  bb: 0.0,  score: -0.1 },
  'Willie Traynor':      { era: 4.06, k: 0.0,  bb: 0.0,  score: -0.1 },
  'Marvin Hudson':       { era: 4.06, k: 0.0,  bb: 0.0,  score: -0.1 },
  'John Bacon':          { era: 4.06, k: 0.0,  bb: 0.0,  score: -0.1 },
  'Bruce Dreckman':      { era: 4.07, k: -0.1, bb: 0.1,  score: -0.2 },
  'Tripp Gibson':        { era: 4.07, k: -0.1, bb: 0.1,  score: -0.2 },
  'Mike Muchlinski':     { era: 4.07, k: -0.1, bb: 0.1,  score: -0.2 },
  'Ryan Wills':          { era: 4.07, k: -0.1, bb: 0.1,  score: -0.2 },
  'Erich Bacchus':       { era: 4.07, k: -0.1, bb: 0.1,  score: -0.2 },
  'Tyler Jones':         { era: 4.07, k: -0.1, bb: 0.1,  score: -0.2 },
  // ── Hitters (ERA 4.08–4.11) ──
  'Mark Ripperger':      { era: 4.08, k: -0.1, bb: 0.1,  score: -0.2 },
  'Dan Bellino':         { era: 4.08, k: -0.1, bb: 0.1,  score: -0.2 },
  'Larry Vanover':       { era: 4.08, k: -0.1, bb: 0.1,  score: -0.2 },
  'David Arrieta':       { era: 4.08, k: -0.1, bb: 0.1,  score: -0.2 },
  'Sean Barber':         { era: 4.08, k: -0.1, bb: 0.1,  score: -0.2 },
  'Jordan Baker':        { era: 4.08, k: -0.1, bb: 0.1,  score: -0.2 },
  'Chad Fairchild':      { era: 4.08, k: -0.1, bb: 0.1,  score: -0.2 },
  'Charlie Ramos':       { era: 4.08, k: -0.1, bb: 0.1,  score: -0.2 },
  'Andy Fletcher':       { era: 4.08, k: -0.1, bb: 0.1,  score: -0.2 },
  'Chris Guccione':      { era: 4.08, k: -0.1, bb: 0.1,  score: -0.2 },
  'John Libka':          { era: 4.09, k: -0.2, bb: 0.1,  score: -0.3 },
  'Jonathan Parra':      { era: 4.09, k: -0.2, bb: 0.1,  score: -0.3 },
  'Derek Thomas':        { era: 4.09, k: -0.2, bb: 0.1,  score: -0.3 },
  'Hunter Wendelstedt':  { era: 4.09, k: -0.2, bb: 0.1,  score: -0.3 },
  'James Hoye':          { era: 4.10, k: -0.2, bb: 0.1,  score: -0.4 },
  'Quinn Wolcott':       { era: 4.10, k: -0.2, bb: 0.1,  score: -0.4 },
  'Manny Gonzalez':      { era: 4.10, k: -0.2, bb: 0.1,  score: -0.4 },
  'Jen Pawol':           { era: 4.10, k: -0.2, bb: 0.1,  score: -0.4 },
  'Alan Porter':         { era: 4.10, k: -0.2, bb: 0.1,  score: -0.4 },
  'Ben May':             { era: 4.10, k: -0.2, bb: 0.1,  score: -0.4 },
  'Jansen Visconti':     { era: 4.10, k: -0.2, bb: 0.1,  score: -0.4 },
  'Stu Scheurwater':     { era: 4.10, k: -0.2, bb: 0.1,  score: -0.4 },
  'Todd Tichenor':       { era: 4.11, k: -0.3, bb: 0.2,  score: -0.5 },
  'Adrian Johnson':      { era: 4.11, k: -0.3, bb: 0.2,  score: -0.5 },
  'Brian Knight':        { era: 4.11, k: -0.3, bb: 0.2,  score: -0.5 },
  'Dan Iassogna':        { era: 4.11, k: -0.3, bb: 0.2,  score: -0.5 },
  // ── Extreme Hitters (ERA ≥ 4.12) ──
  'Ramon De Jesus':      { era: 4.12, k: -0.3, bb: 0.2,  score: -0.6 },
  'Lance Barksdale':     { era: 4.12, k: -0.3, bb: 0.2,  score: -0.6 },
  'James Jean':          { era: 4.13, k: -0.3, bb: 0.2,  score: -0.6 },
  'Mark Wegner':         { era: 4.13, k: -0.3, bb: 0.2,  score: -0.6 },
  'Mark Carlson':        { era: 4.14, k: -0.4, bb: 0.2,  score: -0.7 },
  'Edwin Moscoso':       { era: 4.14, k: -0.4, bb: 0.2,  score: -0.7 },
  'Clint Vondrak':       { era: 4.14, k: -0.4, bb: 0.2,  score: -0.7 },
  'Carlos Torres':       { era: 4.15, k: -0.4, bb: 0.2,  score: -0.8 },
  'Shane Livensparger':  { era: 4.15, k: -0.4, bb: 0.2,  score: -0.8 },
  'Alfonso Marquez':     { era: 4.16, k: -0.4, bb: 0.3,  score: -0.9 },
  'Nic Lentz':           { era: 4.16, k: -0.4, bb: 0.3,  score: -0.9 },
  'Scott Barry':         { era: 4.18, k: -0.5, bb: 0.3,  score: -1.0 },
};

// GET /api/umpires — return full tendency database
app.get('/api/umpires', (req, res) => {
  res.json({ umpires: UMPIRE_DB });
});

// GET /api/umpires/:date — fetch today's HP umpire assignments from MLB schedule
app.get('/api/umpires/:date', async (req, res) => {
  try {
    const date = req.params.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });

    const schedRes = await apiFetch(
      `${MLB_API_BASE}/schedule?sportId=1&date=${date}&gameType=R&hydrate=officials`
    );
    if (!schedRes.ok) throw new Error(`MLB API ${schedRes.status}`);
    const schedule = await schedRes.json();
    const games = schedule.dates?.[0]?.games || [];

    const assignments = games.map(game => {
      const homeAbbr = MLB_TO_DK_ABBR[game.teams?.home?.team?.abbreviation] || game.teams?.home?.team?.abbreviation || '';
      const awayAbbr = MLB_TO_DK_ABBR[game.teams?.away?.team?.abbreviation] || game.teams?.away?.team?.abbreviation || '';
      const officials = game.officials || [];
      const hp = officials.find(o => (o.officialType || '').toLowerCase().includes('home plate'));
      const hpName = hp?.official?.fullName || null;
      const tendency = hpName ? (UMPIRE_DB[hpName] || null) : null;
      return {
        gamePk: game.gamePk,
        homeTeam: homeAbbr,
        awayTeam: awayAbbr,
        game: `${awayAbbr}@${homeAbbr}`,
        hpUmpire: hpName,
        tendency,
        known: !!tendency
      };
    });

    res.json({ success: true, date, assignments });
  } catch (err) {
    res.status(500).json({ error: 'Umpire fetch failed: ' + err.message });
  }
});

// ── DvP (Defense vs. Position) ──────────────────────────────────────────────
// Aggregates last-14-day opponent DK points allowed per position, grouped by team.
// DK positions mapped: SP/RP→P, C, 1B, 2B, 3B, SS, OF, DH→1B
const dvpCacheFile = path.join(dataDir, 'dvp_cache.json');
const DK_POS_MAP = { 'SP': 'P', 'RP': 'P', 'P': 'P', 'C': 'C', '1B': '1B', '2B': '2B',
  '3B': '3B', 'SS': 'SS', 'LF': 'OF', 'CF': 'OF', 'RF': 'OF', 'OF': 'OF', 'DH': '1B' };

app.get('/api/dvp', async (req, res) => {
  try {
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - 14 * 24 * 60 * 60 * 1000);
    const fmt = d => d.toISOString().substring(0, 10);
    const cacheKey = fmt(startDate) + '_' + fmt(endDate);

    if (fs.existsSync(dvpCacheFile)) {
      const cached = JSON.parse(fs.readFileSync(dvpCacheFile, 'utf8'));
      const age = Date.now() - new Date(cached.fetchedAt).getTime();
      if (age < 4 * 60 * 60 * 1000 && cached.cacheKey === cacheKey) {
        return res.json({ success: true, data: cached.data, cached: true });
      }
    }

    const schedRes = await apiFetch(
      `${MLB_API_BASE}/schedule?sportId=1&startDate=${fmt(startDate)}&endDate=${fmt(endDate)}&gameType=R`,
      { timeout: 15000 }
    );
    if (!schedRes.ok) throw new Error(`MLB schedule API ${schedRes.status}`);
    const schedule = await schedRes.json();
    const allGames = [];
    (schedule.dates || []).forEach(d => {
      (d.games || []).forEach(g => { if (g.status?.abstractGameState === 'Final') allGames.push(g.gamePk); });
    });
    if (!allGames.length) return res.json({ success: true, data: {}, message: 'No completed games in window' });

    // dvpAgg: { teamAbbr: { pos: { dkTotal, games } } }
    const dvpAgg = {};

    const chunk = (arr, size) => { const r = []; for (let i = 0; i < arr.length; i += size) r.push(arr.slice(i, i + size)); return r; };
    for (const batch of chunk(allGames.slice(0, 60), 8)) {
      await Promise.all(batch.map(async (gamePk) => {
        try {
          const br = await apiFetch(`${MLB_API_BASE}/game/${gamePk}/boxscore`, { timeout: 10000 });
          if (!br.ok) return;
          const box = await br.json();
          const decisions = box.decisions || {};
          const winnerNorm = normalizeName(decisions.winner?.fullName || '');
          const gameInnings = Math.max(box.linescore?.scheduledInnings || 9, box.linescore?.currentInning || 9);

          for (const [bSide, pSide] of [['home', 'away'], ['away', 'home']]) {
            // bSide = batting team (players scoring DK pts), pSide = pitching/defending team
            const battingTeamData = box.teams?.[bSide];
            const pitchingTeamData = box.teams?.[pSide];
            if (!battingTeamData || !pitchingTeamData) continue;
            const rawDefTeam = pitchingTeamData.team?.abbreviation || '';
            const defTeam = MLB_TO_DK_ABBR[rawDefTeam] || rawDefTeam;
            if (!defTeam) continue;
            if (!dvpAgg[defTeam]) dvpAgg[defTeam] = {};

            for (const player of Object.values(battingTeamData.players || {})) {
              const pos = player.position?.abbreviation || '';
              const dkPos = DK_POS_MAP[pos];
              if (!dkPos) continue;
              const batting = player.stats?.batting || {};
              const pitching = player.stats?.pitching || {};
              const hasBatting = (batting.atBats || 0) > 0 || (batting.baseOnBalls || 0) > 0;
              const hasPitching = parseFloat(pitching.inningsPitched || 0) > 0;
              if (!hasBatting && !hasPitching) continue;

              let dk = 0;
              if (hasBatting) dk += calcHitterDK(batting);
              if (hasPitching) {
                const fullName = player.person?.fullName || '';
                const isWin = normalizeName(fullName) === winnerNorm;
                dk += calcPitcherDK(pitching, isWin, gameInnings);
              }
              if (!dvpAgg[defTeam][dkPos]) dvpAgg[defTeam][dkPos] = { dkTotal: 0, games: 0 };
              dvpAgg[defTeam][dkPos].dkTotal += dk;
              dvpAgg[defTeam][dkPos].games++;
            }
          }
        } catch (e) { /* skip */ }
      }));
    }

    // Compute averages and rank within each position
    const data = {};
    for (const [team, posMap] of Object.entries(dvpAgg)) {
      data[team] = {};
      for (const [pos, agg] of Object.entries(posMap)) {
        if (agg.games < 3) continue;
        data[team][pos] = { avgAllowed: parseFloat((agg.dkTotal / agg.games).toFixed(2)), games: agg.games };
      }
    }

    // Add rank per position across all teams (1 = most allowed = easiest matchup)
    const positions = ['P', 'C', '1B', '2B', '3B', 'SS', 'OF'];
    positions.forEach(pos => {
      const teamAvgs = Object.entries(data)
        .filter(([, pd]) => pd[pos])
        .sort((a, b) => b[1][pos].avgAllowed - a[1][pos].avgAllowed);
      teamAvgs.forEach(([team], rank) => { data[team][pos].rank = rank + 1; data[team][pos].totalTeams = teamAvgs.length; });
    });

    const payload = { data, fetchedAt: new Date().toISOString(), cacheKey };
    fs.writeFileSync(dvpCacheFile, JSON.stringify(payload, null, 2));
    res.json({ success: true, data, cached: false });
  } catch (err) {
    if (fs.existsSync(dvpCacheFile)) {
      const cached = JSON.parse(fs.readFileSync(dvpCacheFile, 'utf8'));
      return res.json({ success: true, data: cached.data, cached: true, stale: true, error: err.message });
    }
    res.status(500).json({ error: 'DvP fetch failed: ' + err.message });
  }
});

// ── Multiplier Segment Analysis ──────────────────────────────────────────────
//
// Groups historical player-actuals by segments that correspond to adjustment
// categories (team/park, batting order, ownership tier) and computes bias per
// segment. This reveals whether each factor class is helping or hurting
// projection accuracy — without needing the raw multiplier values stored.
//
// Interpretation:
//   bias  > +10%  in a segment → projection consistently under-estimates that group
//                               (multipliers for that segment may be too weak, or
//                                the base projection already under-prices it)
//   bias  < -10%  in a segment → projection consistently over-estimates that group
//                               (multipliers may be too aggressive, or projections
//                                already incorporate those factors and you're doubling)

app.get('/api/history/multiplier-analysis', (req, res) => {
  const history = readHistory();

  const pairs = [];
  history.forEach(entry => {
    if (!entry.playerActuals || !Array.isArray(entry.lineup)) return;
    entry.lineup.forEach(p => {
      const actual = entry.playerActuals[p.name];
      if (actual === undefined || actual === null) return;
      const projected = p.median || 0;
      if (projected <= 0) return;
      const relError = (actual - projected) / projected;
      pairs.push({
        name: p.name,
        team: p.team || 'UNK',
        order: p.order || 0,
        own: p.own || 0,
        pos: (p.pos || '').includes('P') ? 'P' : 'BAT',
        projected, actual, relError
      });
    });
  });

  if (pairs.length < 20) {
    return res.json({
      sufficient: false,
      message: `Need at least 20 player actuals. Currently have ${pairs.length}.`
    });
  }

  function segStats(arr) {
    if (!arr.length) return null;
    const n = arr.length;
    const bias = arr.reduce((s, p) => s + p.relError, 0) / n;
    const rmse = Math.sqrt(arr.reduce((s, p) => s + p.relError ** 2, 0) / n);
    return { n, bias: parseFloat(bias.toFixed(4)), rmse: parseFloat(rmse.toFixed(4)) };
  }

  // ── Batting order tiers (order adjustment calibration) ─────────────────
  const batters = pairs.filter(p => p.pos === 'BAT');
  const orderTiers = {
    'top (1-3)':    segStats(batters.filter(p => p.order >= 1 && p.order <= 3)),
    'middle (4-6)': segStats(batters.filter(p => p.order >= 4 && p.order <= 6)),
    'bottom (7-9)': segStats(batters.filter(p => p.order >= 7 && p.order <= 9)),
    'unknown':      segStats(batters.filter(p => p.order === 0))
  };

  // ── Ownership tiers (leverage / GPP-score calibration) ─────────────────
  const ownershipTiers = {
    'chalk (>30%)':    segStats(pairs.filter(p => p.own > 30)),
    'mid (15-30%)':    segStats(pairs.filter(p => p.own > 15 && p.own <= 30)),
    'low (5-15%)':     segStats(pairs.filter(p => p.own > 5  && p.own <= 15)),
    'contrarian (<5%)':segStats(pairs.filter(p => p.own > 0  && p.own <= 5))
  };

  // ── Per-team bias (park factor / Vegas calibration) ─────────────────────
  const teamGroups = {};
  pairs.forEach(p => {
    if (!teamGroups[p.team]) teamGroups[p.team] = [];
    teamGroups[p.team].push(p);
  });
  const teamBias = {};
  Object.entries(teamGroups).forEach(([team, arr]) => {
    if (arr.length >= 5) teamBias[team] = segStats(arr);
  });

  // ── Position bias (pitcher vs batter calibration) ───────────────────────
  const positionBias = {
    pitchers: segStats(pairs.filter(p => p.pos === 'P')),
    batters:  segStats(pairs.filter(p => p.pos === 'BAT'))
  };

  // ── Actionable recommendations ───────────────────────────────────────────
  const recommendations = [];

  // Order tiers
  const topOrder = orderTiers['top (1-3)'];
  const botOrder = orderTiers['bottom (7-9)'];
  if (topOrder && Math.abs(topOrder.bias) > 0.10) {
    recommendations.push(topOrder.bias > 0
      ? `Top-order batters are under-projected by ${(topOrder.bias * 100).toFixed(0)}% on average — consider increasing the order bonus in scoreGpp/scoreCash.`
      : `Top-order batters are over-projected by ${Math.abs(topOrder.bias * 100).toFixed(0)}% — the batting order bonus may be too large.`
    );
  }
  if (botOrder && botOrder.bias > 0.10) {
    recommendations.push(`Bottom-order batters outperform projections by ${(botOrder.bias * 100).toFixed(0)}% — projection source may be systematically under-valuing them.`);
  }

  // Ownership tiers
  const chalk  = ownershipTiers['chalk (>30%)'];
  const contra = ownershipTiers['contrarian (<5%)'];
  if (chalk && chalk.bias < -0.10) {
    recommendations.push(`High-ownership chalk is over-projected by ${Math.abs(chalk.bias * 100).toFixed(0)}% — your chalk plays disappoint more often than expected.`);
  }
  if (contra && contra.bias < -0.15) {
    recommendations.push(`Contrarian plays (<5% own) miss badly (${Math.abs(contra.bias * 100).toFixed(0)}% average over-projection) — the low-ownership edge isn't materializing in your data.`);
  }

  // Team bias outliers (potential park factor / Vegas miscalibration)
  const teamBiasOutliers = Object.entries(teamBias)
    .filter(([, s]) => Math.abs(s.bias) > 0.15 && s.n >= 8)
    .sort((a, b) => Math.abs(b[1].bias) - Math.abs(a[1].bias))
    .slice(0, 5);
  if (teamBiasOutliers.length) {
    teamBiasOutliers.forEach(([team, s]) => {
      recommendations.push(
        s.bias > 0
          ? `${team} players are under-projected by ${(s.bias * 100).toFixed(0)}% (n=${s.n}) — park/Vegas boost may be too small or absent for this team.`
          : `${team} players are over-projected by ${Math.abs(s.bias * 100).toFixed(0)}% (n=${s.n}) — park/Vegas boost may be double-counting factors already in your projection CSV.`
      );
    });
  }

  if (!recommendations.length) {
    recommendations.push('No significant segment bias detected with current data. Collect more actuals for higher confidence.');
  }

  res.json({
    sufficient: true,
    sampleSize: pairs.length,
    orderTiers,
    ownershipTiers,
    teamBias,
    positionBias,
    recommendations
  });
});

// ── Source Quality Tracking ──────────────────────────────────────────────────

const sourceQualityFile = path.join(dataDir, 'source_quality.json');

function readSourceQuality() {
  try {
    if (fs.existsSync(sourceQualityFile)) return JSON.parse(fs.readFileSync(sourceQualityFile, 'utf8'));
  } catch (e) {}
  return {};
}

function writeSourceQuality(data) {
  fs.writeFileSync(sourceQualityFile, JSON.stringify(data, null, 2));
}

function calcSpearman(pairs) {
  const n = pairs.length;
  if (n < 5) return null;
  const sp = [...pairs].sort((a, b) => a.projected - b.projected);
  const sa = [...pairs].sort((a, b) => a.actual - b.actual);
  const pRank = new Array(n), aRank = new Array(n);
  sp.forEach((item, rank) => { pRank[pairs.indexOf(item)] = rank; });
  sa.forEach((item, rank) => { aRank[pairs.indexOf(item)] = rank; });
  let d2 = 0;
  for (let i = 0; i < n; i++) d2 += (pRank[i] - aRank[i]) ** 2;
  return parseFloat((1 - (6 * d2) / (n * (n * n - 1))).toFixed(4));
}

app.get('/api/source-quality', (req, res) => {
  res.json(readSourceQuality());
});

// Called by /api/actuals/apply (and can be called manually) to refresh
// per-source accuracy after new actuals are loaded.
// Body: { date, sources: [ { name: filename, projections: {playerName: median} } ] }
app.post('/api/source-quality/update', (req, res) => {
  const { date, sources } = req.body;
  if (!date || !Array.isArray(sources) || !sources.length) {
    return res.status(400).json({ error: 'date and sources[] required' });
  }

  // Fetch actuals for this date from history
  const history = readHistory();
  const allActuals = {};
  history.forEach(entry => {
    if (!entry.playerActuals) return;
    const eDate = entry.slateDate || entry.date?.substring(0, 10);
    if (eDate !== date) return;
    Object.entries(entry.playerActuals).forEach(([name, score]) => {
      // Take the highest score seen (handles duplicate entries for same slate)
      if (allActuals[name] === undefined || score > allActuals[name]) {
        allActuals[name] = score;
      }
    });
  });

  if (!Object.keys(allActuals).length) {
    return res.json({ updated: 0, message: 'No actuals found for this date. Apply actuals first.' });
  }

  function normName(n) {
    return (n || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
  }

  const quality = readSourceQuality();
  let updatedSources = 0;

  sources.forEach(({ name: fname, projections }) => {
    if (!fname || !projections || !Object.keys(projections).length) return;

    const pairs = [];
    Object.entries(projections).forEach(([pName, projected]) => {
      const norm = normName(pName);
      // Direct match first
      let actual = allActuals[pName] ?? allActuals[norm];
      // Fallback: first-initial + last name
      if (actual === undefined) {
        const parts = norm.split(' ');
        const lastName = parts[parts.length - 1];
        const firstInit = norm.charAt(0);
        const key = Object.keys(allActuals).find(k => {
          const kp = normName(k).split(' ');
          return kp[kp.length - 1] === lastName && normName(k).charAt(0) === firstInit;
        });
        if (key) actual = allActuals[key];
      }
      if (actual !== undefined && projected > 0) {
        pairs.push({ projected, actual });
      }
    });

    if (pairs.length < 5) return;

    const bias = pairs.reduce((s, p) => s + (p.actual - p.projected) / p.projected, 0) / pairs.length;
    const rmse = Math.sqrt(pairs.reduce((s, p) => s + ((p.actual - p.projected) / p.projected) ** 2, 0) / pairs.length);
    const spearman = calcSpearman(pairs);

    if (!quality[fname]) quality[fname] = { slates: [] };
    quality[fname].slates = quality[fname].slates || [];
    // Remove any existing entry for this date so we don't double-count
    quality[fname].slates = quality[fname].slates.filter(s => s.date !== date);
    quality[fname].slates.push({ date, n: pairs.length, bias: parseFloat(bias.toFixed(4)), rmse: parseFloat(rmse.toFixed(4)), spearman });
    // Keep only last 60 slates
    quality[fname].slates = quality[fname].slates.slice(-60);

    // Compute rolling summary
    const slates = quality[fname].slates;
    quality[fname].summary = {
      slateCount: slates.length,
      avgSpearman: parseFloat((slates.reduce((s, sl) => s + (sl.spearman || 0), 0) / slates.length).toFixed(4)),
      avgBias:     parseFloat((slates.reduce((s, sl) => s + sl.bias, 0) / slates.length).toFixed(4)),
      avgRmse:     parseFloat((slates.reduce((s, sl) => s + sl.rmse, 0) / slates.length).toFixed(4)),
      totalSamples: slates.reduce((s, sl) => s + sl.n, 0),
      updatedAt: new Date().toISOString()
    };
    updatedSources++;
  });

  writeSourceQuality(quality);
  res.json({ success: true, updatedSources, quality });
});

app.listen(PORT, () => {
  console.log(`MLB DFS Tool v2.0 running on http://localhost:${PORT}`);
  console.log(`Uploads: ${uploadDir}`);
  console.log(`Data: ${dataDir}`);
});
