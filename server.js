const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = 3000;

// ── The Odds API Config ─────────────────────────────────────────────────────
const ODDS_API_KEY = process.env.ODDS_API_KEY || 'a31ed2d99da8a1068c99c2aefb09a2ea';

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
    const response = await fetch(`https://wttr.in/${city}?format=j1`, {
      headers: { 'User-Agent': 'MLB-DFS-Tool' },
      timeout: 8000
    });
    if (!response.ok) throw new Error(`Weather API returned ${response.status}`);
    const data = await response.json();
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
      const response = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, {
        headers: { 'User-Agent': 'MLB-DFS-Tool' },
        timeout: 8000
      });
      if (!response.ok) throw new Error(`${response.status}`);
      const data = await response.json();
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
  try {
    // Preserve open lines from any existing saved data
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
          merged[team].openAt = prev.openAt || new Date().toISOString();
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
  }
});

// ── Park Factors (static data, loaded once) ─────────────────────────────────

const PARK_FACTORS = {
  COL: { overall: 1.38, hr: 1.40, run: 1.27 },
  CIN: { overall: 1.08, hr: 1.22, run: 1.06 },
  TEX: { overall: 1.07, hr: 1.15, run: 1.05 },
  BOS: { overall: 1.06, hr: 0.96, run: 1.08 },
  MIL: { overall: 1.05, hr: 1.18, run: 1.04 },
  PHI: { overall: 1.04, hr: 1.13, run: 1.03 },
  ATL: { overall: 1.03, hr: 1.10, run: 1.02 },
  CHC: { overall: 1.02, hr: 1.08, run: 1.02 },
  NYY: { overall: 1.02, hr: 1.15, run: 1.01 },
  BAL: { overall: 1.01, hr: 1.09, run: 1.00 },
  MIN: { overall: 1.01, hr: 1.06, run: 1.00 },
  ARI: { overall: 1.00, hr: 0.98, run: 1.01 },
  TOR: { overall: 1.00, hr: 1.05, run: 0.99 },
  LAA: { overall: 0.99, hr: 0.95, run: 0.99 },
  WSH: { overall: 0.99, hr: 1.01, run: 0.98 },
  DET: { overall: 0.98, hr: 0.92, run: 0.98 },
  CLE: { overall: 0.98, hr: 0.90, run: 0.98 },
  HOU: { overall: 0.97, hr: 0.98, run: 0.97 },
  CWS: { overall: 0.97, hr: 1.04, run: 0.96 },
  KC:  { overall: 0.97, hr: 0.88, run: 0.97 },
  PIT: { overall: 0.96, hr: 0.85, run: 0.97 },
  SEA: { overall: 0.96, hr: 0.93, run: 0.96 },
  SD:  { overall: 0.95, hr: 0.86, run: 0.96 },
  LAD: { overall: 0.95, hr: 0.95, run: 0.95 },
  STL: { overall: 0.95, hr: 0.90, run: 0.96 },
  NYM: { overall: 0.94, hr: 0.88, run: 0.95 },
  SF:  { overall: 0.93, hr: 0.82, run: 0.94 },
  TB:  { overall: 0.93, hr: 0.88, run: 0.94 },
  MIA: { overall: 0.92, hr: 0.80, run: 0.93 },
  OAK: { overall: 0.91, hr: 0.83, run: 0.92 }
};

app.get('/api/park-factors', (req, res) => {
  res.json(PARK_FACTORS);
});

app.get('/api/park-factors/:team', (req, res) => {
  const team = req.params.team.toUpperCase();
  res.json(PARK_FACTORS[team] || { overall: 1.00, hr: 1.00, run: 1.00 });
});

// ── Backtesting / Lineup History ────────────────────────────────────────────

const historyFile = path.join(dataDir, 'lineup_history.json');

function readHistory() {
  try {
    if (fs.existsSync(historyFile)) return JSON.parse(fs.readFileSync(historyFile, 'utf8'));
  } catch (e) {}
  return [];
}

function writeHistory(data) {
  fs.writeFileSync(historyFile, JSON.stringify(data, null, 2));
}

app.get('/api/history', (req, res) => {
  res.json(readHistory());
});

app.post('/api/history', (req, res) => {
  const history = readHistory();
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
  // Keep last 500 entries
  if (history.length > 500) history.length = 500;
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

  res.json({
    totalEntries: history.length,
    entriesWithResults: withResults.length,
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
  const boxRes = await fetch(`${MLB_API_BASE}/game/${gamePk}/boxscore`, {
    headers: { 'User-Agent': 'MLB-DFS-Tool' }, timeout: 12000
  });
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

    const schedRes = await fetch(`${MLB_API_BASE}/schedule?sportId=1&date=${date}&gameType=R`, {
      headers: { 'User-Agent': 'MLB-DFS-Tool' }, timeout: 15000
    });
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

    const schedRes = await fetch(`${MLB_API_BASE}/schedule?sportId=1&date=${date}&gameType=R`, {
      headers: { 'User-Agent': 'MLB-DFS-Tool' }, timeout: 15000
    });
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
  try {
    const url = `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds?regions=us&markets=h2h,totals&oddsFormat=american&apiKey=${ODDS_API_KEY}`;
    const response = await fetch(url, { timeout: 12000 });
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

    const schedRes = await fetch(`${MLB_API_BASE}/schedule?sportId=1&date=${date}&gameType=R&hydrate=probablePitcher(note)`, {
      headers: { 'User-Agent': 'MLB-DFS-Tool' }, timeout: 12000
    });
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
          const liveRes = await fetch(`${MLB_API_BASE}/game/${gamePk}/linescore`, {
            headers: { 'User-Agent': 'MLB-DFS-Tool' }, timeout: 8000
          });
          if (liveRes.ok) {
            if (status !== 'Preview') {
              const boxRes = await fetch(`${MLB_API_BASE}/game/${gamePk}/boxscore`, {
                headers: { 'User-Agent': 'MLB-DFS-Tool' }, timeout: 10000
              });
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
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'MLB-DFS-Tool/2.0', 'Accept': 'text/csv' },
    timeout: 20000
  });
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
      return res.json({ success: true, data: cached.data, cached: true, stale: true, error: err.message });
    }
    res.status(500).json({ error: 'Statcast fetch failed: ' + err.message });
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

    const schedRes = await fetch(
      `${MLB_API_BASE}/schedule?sportId=1&startDate=${fmt(startDate)}&endDate=${fmt(endDate)}&gameType=R`,
      { headers: { 'User-Agent': 'MLB-DFS-Tool' }, timeout: 15000 }
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
          const br = await fetch(`${MLB_API_BASE}/game/${gamePk}/boxscore`, { headers: { 'User-Agent': 'MLB-DFS-Tool' }, timeout: 10000 });
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

    const txRes = await fetch(
      `${MLB_API_BASE}/transactions?startDate=${fmt(start)}&endDate=${fmt(end)}&sportId=1`,
      { headers: { 'User-Agent': 'MLB-DFS-Tool' }, timeout: 12000 }
    );
    if (!txRes.ok) throw new Error(`MLB API ${txRes.status}`);
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
// Scale: -2 (very hitter-friendly) to +2 (very pitcher-friendly)
// Source: multi-season historical K% and walk% relative to league average
const UMPIRE_DB = {
  'Angel Hernandez':     { k: -0.5, bb: 0.3,  score: -0.4 },
  'CB Bucknor':          { k: -0.8, bb: 0.5,  score: -0.6 },
  'Hunter Wendelstedt':  { k: 1.2,  bb: -0.4, score: 1.0  },
  'Dan Bellino':         { k: 1.0,  bb: -0.3, score: 0.8  },
  'Mark Carlson':        { k: -0.4, bb: 0.2,  score: -0.3 },
  'Jeff Nelson':         { k: 0.2,  bb: -0.1, score: 0.1  },
  'Phil Cuzzi':          { k: 0.6,  bb: -0.2, score: 0.5  },
  'Tom Hallion':         { k: 0.8,  bb: -0.3, score: 0.7  },
  'Ron Kulpa':           { k: 0.9,  bb: -0.4, score: 0.8  },
  'Mike Winters':        { k: 0.5,  bb: -0.2, score: 0.4  },
  'Laz Diaz':            { k: -1.0, bb: 0.6,  score: -0.8 },
  'Ted Barrett':         { k: 0.3,  bb: -0.1, score: 0.2  },
  'Pat Hoberg':          { k: 0.1,  bb: 0.0,  score: 0.1  },
  'Alan Porter':         { k: 0.4,  bb: -0.2, score: 0.3  },
  'Carlos Torres':       { k: -0.3, bb: 0.2,  score: -0.2 },
  'John Tumpane':        { k: 0.6,  bb: -0.3, score: 0.5  },
  'Mike Muchlinski':     { k: 0.2,  bb: 0.0,  score: 0.2  },
  'Gabe Morales':        { k: -0.2, bb: 0.2,  score: -0.1 },
  'Bill Welke':          { k: 0.3,  bb: -0.1, score: 0.3  },
  'Vic Carapazza':       { k: 0.7,  bb: -0.3, score: 0.6  },
  'Jerry Meals':         { k: -0.1, bb: 0.1,  score: -0.1 },
  'Doug Eddings':        { k: 0.4,  bb: -0.2, score: 0.3  },
  'Brian O\'Nora':       { k: 0.2,  bb: -0.1, score: 0.2  },
  'Alfonso Marquez':     { k: 0.5,  bb: -0.2, score: 0.4  },
  'Andy Fletcher':       { k: -0.2, bb: 0.1,  score: -0.1 },
  'Cory Blaser':         { k: 0.3,  bb: -0.1, score: 0.3  },
  'Junior Valentine':    { k: -0.6, bb: 0.4,  score: -0.5 },
  'Bruce Dreckman':      { k: 0.4,  bb: -0.2, score: 0.3  },
  'Quinn Wolcott':       { k: 0.1,  bb: 0.0,  score: 0.1  },
  'Adam Hamari':         { k: -0.3, bb: 0.2,  score: -0.2 },
  'Chad Fairchild':      { k: -0.5, bb: 0.3,  score: -0.4 },
  'Erich Bacchus':       { k: 0.2,  bb: -0.1, score: 0.1  },
  'Jeremie Rehak':       { k: 0.3,  bb: -0.1, score: 0.2  },
  'Nic Lentz':           { k: 0.4,  bb: -0.2, score: 0.3  },
  'Roberto Ortiz':       { k: -0.1, bb: 0.1,  score: 0.0  },
  'Tripp Gibson':        { k: 0.5,  bb: -0.2, score: 0.4  },
  'Will Little':         { k: 0.6,  bb: -0.3, score: 0.5  },
  'David Rackley':       { k: 0.3,  bb: -0.1, score: 0.2  },
  'Mike Estabrook':      { k: 0.1,  bb: 0.0,  score: 0.1  },
  'Marvin Hudson':       { k: -0.4, bb: 0.2,  score: -0.3 },
  'Mark Wegner':         { k: 0.2,  bb: -0.1, score: 0.1  },
  'Fieldin Culbreth':    { k: 0.3,  bb: -0.1, score: 0.3  },
  'Greg Gibson':         { k: -0.2, bb: 0.1,  score: -0.1 },
  'Lance Barrett':       { k: 0.4,  bb: -0.2, score: 0.3  },
  'Paul Nauert':         { k: 0.0,  bb: 0.1,  score: 0.0  },
  'Manny Gonzalez':      { k: -0.3, bb: 0.2,  score: -0.2 },
  'Brian Knight':        { k: 0.5,  bb: -0.2, score: 0.4  },
  'Chris Guccione':      { k: 0.3,  bb: -0.1, score: 0.3  },
  'D.J. Reyburn':        { k: 0.2,  bb: -0.1, score: 0.2  },
  'Ryan Additon':        { k: 0.1,  bb: 0.0,  score: 0.1  },
  'Mike DiMuro':         { k: -0.1, bb: 0.1,  score: -0.1 },
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

    const schedRes = await fetch(
      `${MLB_API_BASE}/schedule?sportId=1&date=${date}&gameType=R&hydrate=officials`,
      { headers: { 'User-Agent': 'MLB-DFS-Tool' }, timeout: 12000 }
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

app.listen(PORT, () => {
  console.log(`MLB DFS Tool v2.0 running on http://localhost:${PORT}`);
  console.log(`Uploads: ${uploadDir}`);
  console.log(`Data: ${dataDir}`);
});
