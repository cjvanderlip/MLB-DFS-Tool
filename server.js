require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const fetch = require('node-fetch');

// ── Debug logging ───────────────────────────────────────────────────────────
// Enabled by setting DEBUG=true (or 1 / yes / on) in the environment.
//   PowerShell: $env:DEBUG='true'; npm start
//   bash:       DEBUG=true npm start
// When on:
//   - Every HTTP request gets a one-line log with method, path, status, duration
//   - Every external fetch logs URL + duration + outcome (apiFetch)
//   - Cache hits/misses logged for history + slate_actuals + source_quality
const DEBUG = /^(1|true|yes|on)$/i.test(String(process.env.DEBUG || ''));
function dlog(...args) {
  if (!DEBUG) return;
  const ts = new Date().toISOString().split('T')[1].replace('Z', '');
  console.log('[debug ' + ts + ']', ...args);
}

// Centralized fetch wrapper — consistent User-Agent, default timeout, error format.
// When DEBUG is on, logs URL, status, and elapsed ms for every outbound API call.
function apiFetch(url, opts = {}) {
  const { timeout = 12000, headers = {}, ...rest } = opts;
  // Node.js fetch ignores unknown options — use AbortController for real timeout enforcement.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  const started = DEBUG ? Date.now() : 0;
  return fetch(url, { ...rest, headers: { 'User-Agent': 'MLB-DFS-Tool/2.0', ...headers }, signal: controller.signal })
    .then(res => {
      if (DEBUG) {
        const ms = Date.now() - started;
        // Truncate long URLs (query strings can be huge on some endpoints)
        const u = url.length > 120 ? url.slice(0, 117) + '...' : url;
        dlog('fetch', res.status, ms + 'ms', u);
      }
      return res;
    })
    .catch(err => {
      if (DEBUG) {
        const ms = Date.now() - started;
        dlog('fetch FAIL', ms + 'ms', err.message, url);
      }
      throw err;
    })
    .finally(() => clearTimeout(timeoutId));
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

// Request logging — only registered when DEBUG is on so the hot path stays clean
// in production. Logs method, path, status, response time. Skips static asset hits
// (which static middleware handles before this) and dotfiles.
if (DEBUG) {
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - started;
      dlog(req.method, res.statusCode, ms + 'ms', req.path);
    });
    next();
  });
}

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
  const safePrefix = uploadDir + path.sep;
  if (!filepath.startsWith(safePrefix)) return res.status(403).json({ error: 'Forbidden' });
  fs.unlink(filepath, (err) => {
    if (err) return res.status(500).json({ error: 'Failed to delete file' });
    res.json({ success: true });
  });
});

app.get('/api/files/:filename/content', (req, res) => {
  const filepath = path.join(uploadDir, req.params.filename);
  const safePrefix = uploadDir + path.sep;
  if (!filepath.startsWith(safePrefix)) return res.status(403).json({ error: 'Forbidden' });
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
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('Weather API returned non-JSON response'); }
    if (!data.current_condition) throw new Error('Unexpected response format from weather API');
    const current = data.current_condition?.[0] || {};
    const hourly = data.weather?.[0]?.hourly || [];
    // Cover day games (1200) through late west-coast games (2100)
    const gameHour = hourly.find(h => parseInt(h.time) >= 1200 && parseInt(h.time) <= 2100) || hourly[2] || current;
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

// Batch weather for multiple teams — keyed by team code, fetched via GPS coords.
// Accepts { teams: ['NYY','BOS',...] }. Falls back to { cities: [...] } for
// backward compat, but teams+coords is more accurate (avoids wrong city centers).
app.post('/api/weather/batch', async (req, res) => {
  const { teams, cities } = req.body;
  // Build a lookup: key → coord_or_city for wttr.in query
  let lookup; // Map<key, queryString>
  if (teams && Array.isArray(teams)) {
    lookup = new Map();
    [...new Set(teams)].forEach(team => {
      const coord = STADIUM_COORDS[team];
      if (coord) lookup.set(team, coord);
    });
  } else if (cities && Array.isArray(cities)) {
    // Legacy city-name fallback
    lookup = new Map([...new Set(cities)].map(c => [c, c]));
  } else {
    return res.status(400).json({ error: 'teams or cities array required' });
  }
  if (!lookup.size) return res.json({});

  const results = {};
  const entries = [...lookup.entries()];

  // Process in batches of 4 with a 200ms pause between batches to avoid
  // hammering wttr.in (free service, no key) with 15+ simultaneous requests
  // which causes rate-limiting and HTML error responses.
  const BATCH_SIZE = 4;
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async ([key, query]) => {
      try {
        const response = await apiFetch(`https://wttr.in/${encodeURIComponent(query)}?format=j1`, { timeout: 8000 });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        // wttr.in sometimes returns text/plain even for valid JSON — parse regardless,
        // only fail if the body is actually unparseable.
        const text = await response.text();
        let data;
        try { data = JSON.parse(text); } catch { throw new Error('non-JSON response from weather API'); }
        if (!data.current_condition) throw new Error('unexpected weather API format');
        const current = data.current_condition?.[0] || {};
        const hourly = data.weather?.[0]?.hourly || [];
        // Cover day games (1200) through late night west-coast games (2100).
        // Fall back to the 3rd hourly slot (typically mid-afternoon) then current.
        const gameHour = hourly.find(h => parseInt(h.time) >= 1200 && parseInt(h.time) <= 2100) || hourly[2] || current;
        results[key] = {
          temp_f: parseInt(gameHour.tempF || current.temp_F || 72),
          wind_mph: parseInt(gameHour.windspeedMiles || current.windspeedMiles || 5),
          wind_dir: gameHour.winddir16Point || current.winddir16Point || 'N',
          precip_chance: parseInt(gameHour.chanceofrain || 0),
          humidity: parseInt(gameHour.humidity || current.humidity || 50),
          condition: current.weatherDesc?.[0]?.value || 'Unknown'
        };
      } catch (e) {
        results[key] = { error: e.message };
      }
    }));
    // Brief pause between batches to stay under free-tier rate limits
    if (i + BATCH_SIZE < entries.length) await new Promise(r => setTimeout(r, 200));
  }
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
  // Validate: body must be a plain object whose keys are team abbreviations
  // and whose values are objects with numeric impliedTotal
  const rawIncoming = req.body;
  if (!rawIncoming || typeof rawIncoming !== 'object' || Array.isArray(rawIncoming)) {
    return res.status(400).json({ error: 'Request body must be a JSON object keyed by team abbreviation.' });
  }
  // Canonicalize incoming team keys through MLB_TO_DK_ABBR so legacy codes (OAK, AZ,
  // SFG, etc.) get merged into the current DK code (ATH, ARI, SF, ...). Without this
  // canonicalization a partial alias rollout leaves orphan keys in vegas.json that
  // later cause "off-slate teams" warnings.
  const incoming = {};
  for (const [rawTeam, info] of Object.entries(rawIncoming)) {
    const team = MLB_TO_DK_ABBR[rawTeam.toUpperCase()] || rawTeam.toUpperCase();
    // If two incoming keys map to the same canonical code, take the entry with the
    // higher impliedTotal as the truth (or the last one if neither has a total).
    if (incoming[team] && incoming[team].impliedTotal != null &&
        info?.impliedTotal != null && info.impliedTotal < incoming[team].impliedTotal) {
      continue;
    }
    incoming[team] = info;
  }
  for (const [team, info] of Object.entries(incoming)) {
    if (!/^[A-Z0-9]{1,5}$/.test(team)) {
      return res.status(400).json({ error: `Invalid team abbreviation: "${team}"` });
    }
    if (info === null || typeof info !== 'object') {
      return res.status(400).json({ error: `Value for team "${team}" must be an object.` });
    }
    if (info.impliedTotal !== undefined) {
      const t = Number(info.impliedTotal);
      if (!isFinite(t) || t < 0 || t > 30) {
        return res.status(400).json({ error: `impliedTotal for "${team}" must be a number between 0 and 30.` });
      }
    }
  }
  vegasWriteLock = true;
  try {
    // Re-read the file inside the lock so we always merge against the latest state
    let existing = {};
    if (fs.existsSync(vegasFile)) {
      try { existing = JSON.parse(fs.readFileSync(vegasFile, 'utf8')); } catch (e) {}
    }
    const merged = {};
    const allTeams = new Set([...Object.keys(existing), ...Object.keys(incoming)]);
    allTeams.forEach(team => {
      const prev = existing[team] || {};
      const curr = incoming[team] || {};

      // Drop entries that arrived with no impliedTotal (e.g. stale empty placeholders).
      // Teams only in `existing` with no impliedTotal are also dropped — they're orphans
      // from old slates. This prevents ATH:{} ghost entries from accumulating.
      if (curr.impliedTotal == null && prev.impliedTotal == null) return;

      merged[team] = { ...curr };

      if (curr.impliedTotal != null) {
        merged[team].impliedTotal = curr.impliedTotal;

        // Detect a new slate: if the game's commenceTime differs from the stored openAt
        // date (calendar-day comparison), treat this as a fresh game and reset openTotal.
        // This prevents March 30 open lines from corrupting April 18 movement signals.
        const newGameDay = curr.commenceTime ? curr.commenceTime.slice(0, 10) : null;
        const oldGameDay = prev.openAt ? prev.openAt.slice(0, 10) : null;
        const isNewGame = !prev.openTotal || (newGameDay && oldGameDay && newGameDay !== oldGameDay);

        if (isNewGame) {
          merged[team].openTotal = curr.impliedTotal;
          merged[team].openAt = new Date().toISOString();
        } else {
          // Same game — preserve original open line for movement tracking
          merged[team].openTotal = prev.openTotal;
          merged[team].openAt = prev.openAt;
        }
        merged[team].lastFetchedAt = new Date().toISOString();
      } else if (prev.impliedTotal != null) {
        // Incoming has no impliedTotal (manual save path) — keep existing data intact
        merged[team] = { ...prev };
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

let PARK_FACTORS = {};
try {
  PARK_FACTORS = JSON.parse(fs.readFileSync(path.join(dataDir, 'park_factors.json'), 'utf8'));
} catch (e) {
  console.warn('[Startup] park_factors.json missing or corrupt — park factors disabled:', e.message);
}

app.get('/api/park-factors', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400'); // park factors change at most daily
  res.json(PARK_FACTORS);
});

app.get('/api/park-factors/:team', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  const team = req.params.team.toUpperCase();
  res.json(PARK_FACTORS[team] || { overall: 1.00, hr: 1.00, run: 1.00 });
});

// ── Backtesting / Lineup History ────────────────────────────────────────────

const historyFile = path.join(dataDir, 'lineup_history.json');
const historySettingsFile = path.join(dataDir, 'history_settings.json');

// In-memory cache — eliminates JSON.parse + disk I/O on every API call.
// Invalidated on every write; reads return the cached object directly (callers must not mutate it).
let _historyCache = null;

async function readHistory() {
  if (_historyCache) {
    dlog('history cache HIT', _historyCache.length, 'entries');
    return _historyCache;
  }
  try {
    const data = await fs.promises.readFile(historyFile, 'utf8');
    _historyCache = JSON.parse(data);
    dlog('history cache MISS — loaded', _historyCache.length, 'entries from disk');
    return _historyCache;
  } catch (e) {
    dlog('history cache MISS — file missing/unreadable, returning []');
    return [];
  }
}

async function writeHistory(data) {
  _historyCache = data;
  await fs.promises.writeFile(historyFile, JSON.stringify(data, null, 2));
  dlog('history WRITE', data.length, 'entries');
}

async function readHistorySettings() {
  try {
    const data = await fs.promises.readFile(historySettingsFile, 'utf8');
    return JSON.parse(data);
  } catch (e) { return { maxSlates: 30, stripPoolAfterSlates: 5 }; }
}

async function writeHistorySettings(s) {
  await fs.promises.writeFile(historySettingsFile, JSON.stringify(s, null, 2));
}

let historyWriteLock = false; // simple in-process mutex — prevents concurrent read-modify-write

function pruneHistory(history, settings) {
  if (!history.length) return history;
  const { maxSlates, stripPoolAfterSlates } = settings;
  // Stub entries (imported from DK CSV) are lightweight — keep all of them regardless of age.
  const stubs   = history.filter(h => h._stub);
  const lineups = history.filter(h => !h._stub);
  // Group saved lineups by slateDate, keep only the most recent maxSlates dates
  const slateDates = [...new Set(lineups.map(h => h.slateDate || ''))].sort().reverse();
  const keepDates  = new Set(slateDates.slice(0, maxSlates));
  const stripDates = new Set(slateDates.slice(stripPoolAfterSlates));
  let pruned = lineups.filter(h => keepDates.has(h.slateDate || ''));
  for (const entry of pruned) {
    if (stripDates.has(entry.slateDate || '') && entry.poolSnapshot?.length) {
      entry.poolSnapshot = [];
    }
  }
  return [...stubs, ...pruned];
}

app.get('/api/history/settings', async (req, res) => {
  try { res.json(await readHistorySettings()); }
  catch (e) { res.status(500).json({ error: 'Failed to read history settings' }); }
});

app.put('/api/history/settings', async (req, res) => {
  try {
    const maxSlates = Math.max(1, Math.min(365, parseInt(req.body.maxSlates) || 30));
    const stripPoolAfterSlates = Math.max(1, Math.min(maxSlates, parseInt(req.body.stripPoolAfterSlates) || 5));
    const settings = { maxSlates, stripPoolAfterSlates };
    await writeHistorySettings(settings);
    // Apply pruning immediately with new settings
    let history = await readHistory();
    history = pruneHistory(history, settings);
    await writeHistory(history);
    res.json({ success: true, settings, entriesAfterPrune: history.length });
  } catch (e) { res.status(500).json({ error: 'Failed to update history settings' }); }
});

app.post('/api/history/prune', async (req, res) => {
  try {
    const settings = await readHistorySettings();
    let history = await readHistory();
    const before = history.length;
    history = pruneHistory(history, settings);
    await writeHistory(history);
    res.json({ success: true, before, after: history.length, removed: before - history.length });
  } catch (e) { res.status(500).json({ error: 'Failed to prune history' }); }
});

app.get('/api/history', async (req, res) => {
  try { res.json(await readHistory()); }
  catch (e) { res.status(500).json({ error: 'Failed to read history' }); }
});

app.post('/api/history', async (req, res) => {
  if (historyWriteLock) {
    return res.status(409).json({ error: 'History is being updated — please retry in a moment.' });
  }
  historyWriteLock = true;
  try {
    let history = await readHistory();
    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      date: new Date().toISOString(),
      slateDate: req.body.slateDate || new Date().toISOString().substring(0, 10),
      slate: req.body.slate || 'Main',
      contest: req.body.contest || 'GPP',
      lineup: req.body.lineup || [],
      poolSnapshot: req.body.poolSnapshot || [],
      sources: req.body.sources || [],
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
    const settings = await readHistorySettings();
    history = pruneHistory(history, settings);
    await writeHistory(history);
    res.json({ success: true, id: entry.id });
  } catch (e) { res.status(500).json({ error: 'Failed to save history entry' }); }
  finally { historyWriteLock = false; }
});

app.put('/api/history/:id', async (req, res) => {
  try {
    const history = await readHistory();
    const idx = history.findIndex(h => h.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    Object.assign(history[idx], req.body);
    await writeHistory(history);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Failed to update history entry' }); }
});

app.delete('/api/history/:id', async (req, res) => {
  try {
    let history = await readHistory();
    history = history.filter(h => h.id !== req.params.id);
    await writeHistory(history);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Failed to delete history entry' }); }
});

// ROI summary
app.get('/api/history/summary', async (req, res) => {
  try {
  const history = await readHistory();
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
  const historySettings = await readHistorySettings();

  // Item 6: Finish percentile tracking — use recorded finish/entries when available.
  // finishPct = (entries - finish) / entries * 100  (0 = last, 100 = first)
  const withFinish = history.filter(h => h.finish > 0 && h.entries > 0);
  const avgFinishPct = withFinish.length > 0
    ? withFinish.reduce((s, h) => s + (h.entries - h.finish) / h.entries * 100, 0) / withFinish.length
    : null;

  // Cash rate: % of financially-tracked entries where winnings > 0
  const cashRate = withFinancials.length > 0
    ? (withFinancials.filter(h => (h.winnings || 0) > 0).length / withFinancials.length * 100)
    : null;

  // Item 9: Rake break-even thresholds.
  // DraftKings typically takes 8–15% (we model 10%).
  // Break-even cash rate = 1 / (payout_mult × (1 - rake)).
  // If your actual cash rate is below this, you are losing money long-term.
  const RAKE = 0.10;
  const breakEven = {
    gpp_top20:  { label: 'GPP top 20% (2x)',       requiredCashRate: parseFloat((1 / (2.0 * (1 - RAKE)) * 100).toFixed(1)) },
    gpp_top10:  { label: 'GPP top 10% (3x)',        requiredCashRate: parseFloat((1 / (3.0 * (1 - RAKE)) * 100).toFixed(1)) },
    double_up:  { label: 'Double-up (1.9x)',         requiredCashRate: parseFloat((1 / (1.9 * (1 - RAKE)) * 100).toFixed(1)) },
    note: `At ${RAKE * 100}% rake. Your actual cash rate must exceed these thresholds to be long-term profitable.`
  };

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
    byContest,
    // Item 6
    avgFinishPct: avgFinishPct !== null ? parseFloat(avgFinishPct.toFixed(1)) : null,
    cashRate: cashRate !== null ? parseFloat(cashRate.toFixed(1)) : null,
    entriesWithFinish: withFinish.length,
    // Item 9
    breakEven
  });
  } catch (e) { res.status(500).json({ error: 'Failed to load history summary' }); }
});

// GET /api/history/score-benchmarks
// Score distribution benchmarks derived from historical contest entries.
// Works with stub data (no player actuals needed).
// Returns percentiles, estimated cash/win lines, simDiversity calibration suggestion,
// and ownershipLambda suggestion — all feedable directly into portfolio/simulator params.
app.get('/api/history/score-benchmarks', async (req, res) => {
  try {
    const history = await readHistory();

    // All entries with an actual score
    const scored = history.filter(h => h.actualPts > 0);
    if (scored.length < 5) {
      return res.json({ sufficient: false, count: scored.length,
        message: 'Need at least 5 scored entries. Re-import your DK contest CSV.' });
    }

    // Score percentiles
    const scores = scored.map(h => h.actualPts).sort((a, b) => a - b);
    const pct = (p) => scores[Math.max(0, Math.floor(scores.length * p) - 1)];
    const scorePercentiles = {
      p10: parseFloat(pct(0.10).toFixed(2)),
      p25: parseFloat(pct(0.25).toFixed(2)),
      p50: parseFloat(pct(0.50).toFixed(2)),
      p75: parseFloat(pct(0.75).toFixed(2)),
      p90: parseFloat(pct(0.90).toFixed(2)),
      p95: parseFloat(pct(0.95).toFixed(2)),
      mean: parseFloat((scores.reduce((s, x) => s + x, 0) / scores.length).toFixed(2)),
    };

    // Cash/win line estimate from historical contest entries.
    //
    // Previously used Math.min(actualPts), which made one disaster slate (e.g. a
    // 22k-entry GPP on a heavily-rained-out day where the field-wide cash line
    // collapsed to ~21 pts) poison the entire estimate. Switched to a robust
    // percentile + small-field exclusion so the metric reflects "what score do
    // I typically need to cash in a real large-field GPP?" rather than "what's
    // the most extreme outlier I've ever cashed with?".
    //
    // Rules:
    //   1. Exclude small-field contests (< 100 entries) — H2H, satellites, beginner
    //      pools have different score distributions and aren't predictive.
    //   2. Use 10th-percentile of cashing scores rather than min — survives a small
    //      number of postponement-driven anomalies in the history.
    //   3. Require ≥ 5 qualifying entries for the estimate to be returned at all.
    const percentile = (arr, p) => {
      if (!arr.length) return null;
      const sorted = arr.slice().sort((a, b) => a - b);
      return sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * p)))];
    };
    const MIN_CONTEST_SIZE = 100;
    const withFinish = scored.filter(h => h.finish > 0 && h.entries > 0);
    const sizedFinish = withFinish.filter(h => h.entries >= MIN_CONTEST_SIZE);
    const cashingEntries = sizedFinish.filter(h => h.finish / h.entries <= 0.22);
    const gppWinEntries  = sizedFinish.filter(h => h.finish / h.entries <= 0.05);
    const cashScores = cashingEntries.map(h => h.actualPts);
    const winScores  = gppWinEntries.map(h => h.actualPts);
    const estCashLine = cashingEntries.length >= 5
      ? parseFloat(percentile(cashScores, 0.10).toFixed(2)) : null;
    const estWinLine  = gppWinEntries.length >= 5
      ? parseFloat(percentile(winScores, 0.10).toFixed(2))  : null;
    // Surface diagnostic info so the UI can explain how the estimate was built
    // and warn when many small-field entries were excluded.
    const benchmarkMeta = {
      cashSampleSize: cashingEntries.length,
      winSampleSize: gppWinEntries.length,
      minContestSize: MIN_CONTEST_SIZE,
      excludedSmallFields: withFinish.length - sizedFinish.length,
      // Raw min/max for transparency (lets the user see the outlier they're escaping)
      cashMinObserved: cashScores.length ? parseFloat(Math.min(...cashScores).toFixed(1)) : null,
      cashMedian: cashScores.length ? parseFloat(percentile(cashScores, 0.50).toFixed(1)) : null,
      winMinObserved: winScores.length ? parseFloat(Math.min(...winScores).toFixed(1)) : null,
      winMedian: winScores.length ? parseFloat(percentile(winScores, 0.50).toFixed(1)) : null,
    };

    // simDiversity calibration: compare spread of actual scores vs projected scores.
    // actual_std / projected_std > 1.1 → sim is under-dispersed → increase simDiversity.
    const lineupPairs = history.filter(h => h.projectedPts > 0 && h.actualPts > 0);
    let simDiversitySuggestion = null;
    if (lineupPairs.length >= 5) {
      const projMean = lineupPairs.reduce((s, h) => s + h.projectedPts, 0) / lineupPairs.length;
      const actMean  = lineupPairs.reduce((s, h) => s + h.actualPts,    0) / lineupPairs.length;
      const projStd  = Math.sqrt(lineupPairs.reduce((s, h) => s + (h.projectedPts - projMean) ** 2, 0) / lineupPairs.length);
      const actStd   = Math.sqrt(lineupPairs.reduce((s, h) => s + (h.actualPts    - actMean)  ** 2, 0) / lineupPairs.length);
      const ratio = actStd > 0 && projStd > 0 ? actStd / projStd : null;
      if (ratio) {
        const suggested = Math.min(2.5, Math.max(0.5, parseFloat(ratio.toFixed(2))));
        simDiversitySuggestion = { projStd: parseFloat(projStd.toFixed(2)), actStd: parseFloat(actStd.toFixed(2)),
          ratio: parseFloat(ratio.toFixed(2)), suggested, sampleSize: lineupPairs.length };
      }
    }

    // ownershipLambda suggestion: if cash rate is below GPP break-even, reduce lambda
    // (chase higher-ceiling, lower-owned plays). If well above break-even, increase lambda.
    const withWinnings = history.filter(h => h.winnings != null);
    let lambdaSuggestion = null;
    if (withWinnings.length >= 10) {
      const cashRate = withWinnings.filter(h => h.winnings > 0).length / withWinnings.length;
      const breakEven = 0.556; // ~55.6% for double-up at 10% rake; ~55% is a useful universal floor
      const currentLambdaHint = cashRate < 0.35 ? 'increase' : cashRate > 0.55 ? 'decrease' : 'maintain';
      lambdaSuggestion = { cashRate: parseFloat((cashRate * 100).toFixed(1)), breakEvenPct: 55.6,
        hint: currentLambdaHint, sampleSize: withWinnings.length };
    }

    res.json({
      sufficient: true, count: scored.length,
      scorePercentiles, estCashLine, estWinLine,
      simDiversitySuggestion, lambdaSuggestion,
      withFinishCount: withFinish.length,
      benchmarkMeta,
    });
  } catch (e) { res.status(500).json({ error: 'Failed to compute score benchmarks: ' + e.message }); }
});

// ── MLB Stats API — Actual Player DK Scores ─────────────────────────────────

const MLB_API_BASE = 'https://statsapi.mlb.com/api/v1';

// MLB Stats API team abbreviations that differ from DK.
// Note: DK rebranded the Athletics to ATH in 2025, so MLB API's 'ATH' is now also
// DK's code — no translation needed. We map the legacy OAK → ATH forward so any
// older feed that still emits OAK gets normalized to the current DK code.
const MLB_TO_DK_ABBR = { 'AZ': 'ARI', 'WAS': 'WSH', 'OAK': 'ATH', 'SDP': 'SD', 'SFG': 'SF', 'TBR': 'TB', 'KCR': 'KC' };

// Static team ID → abbreviation map (from /api/v1/teams?sportId=1).
// The schedule API doesn't return abbreviation without `hydrate=team`.
const MLB_TEAM_ID_TO_ABBR = {
  108: 'LAA', 109: 'ARI', 110: 'BAL', 111: 'BOS', 112: 'CHC',
  113: 'CIN', 114: 'CLE', 115: 'COL', 116: 'DET', 117: 'HOU',
  118: 'KC',  119: 'LAD', 120: 'WSH', 121: 'NYM', 133: 'OAK',
  134: 'PIT', 135: 'SD',  136: 'SEA', 137: 'SF',  138: 'STL',
  139: 'TB',  140: 'TEX', 141: 'TOR', 142: 'MIN', 143: 'PHI',
  144: 'ATL', 145: 'CWS', 146: 'MIA', 147: 'NYY', 158: 'MIL'
};

// Resolve team abbreviation from game data: prefer ID lookup, fallback to abbreviation field + DK mapping
function resolveTeamAbbr(teamData) {
  const id = teamData?.team?.id;
  if (id && MLB_TEAM_ID_TO_ABBR[id]) return MLB_TEAM_ID_TO_ABBR[id];
  const abbr = teamData?.team?.abbreviation || '';
  return MLB_TO_DK_ABBR[abbr] || abbr;
}

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
    // Track per-game failures so the client can surface "loaded 13/15 — 2 games failed"
    // rather than silently presenting partial data as complete.
    const failedGames = [];
    await Promise.all(games.map(async (game) => {
      try {
        const scores = await fetchGameActuals(game.gamePk);
        if (!scores) {
          failedGames.push({ gamePk: game.gamePk, reason: 'boxscore unavailable' });
          return;
        }
        // Accumulate instead of overwrite — players in doubleheaders appear in multiple games
        for (const [key, val] of Object.entries(scores)) {
          if (allScores[key]) {
            allScores[key] = { ...allScores[key], dkScore: (allScores[key].dkScore || 0) + (val.dkScore || 0) };
          } else {
            allScores[key] = val;
          }
        }
      } catch (e) {
        console.error(`Game ${game.gamePk} failed:`, e.message);
        failedGames.push({ gamePk: game.gamePk, reason: e.message });
      }
    }));

    const players = Object.values(allScores).sort((a, b) => b.dkScore - a.dkScore);
    const loadedCount = games.length - failedGames.length;
    res.json({
      success: true, date, players,
      gameCount: games.length,
      loadedGameCount: loadedCount,
      failedGames, // empty array on full success — never undefined
    });
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
    const failedGames = [];
    await Promise.all(games.map(async (game) => {
      try {
        const scores = await fetchGameActuals(game.gamePk);
        if (scores) {
          Object.entries(scores).forEach(([k, v]) => {
            playerScores[k] = (playerScores[k] || 0) + v.dkScore;
          });
        } else {
          failedGames.push({ gamePk: game.gamePk, reason: 'boxscore unavailable' });
        }
      } catch (e) {
        console.error(`Apply actuals game ${game.gamePk} failed:`, e.message);
        failedGames.push({ gamePk: game.gamePk, reason: e.message });
      }
    }));

    if (!Object.keys(playerScores).length) {
      return res.json({ success: true, updated: 0, failedGames, gameCount: games.length, message: 'Could not retrieve player scores' });
    }

    // Match history entries for this date
    const history = await readHistory();
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

    await writeHistory(history);

    // Item 7: Persist full slate actuals for source quality tracker.
    // Source quality needs all ~300 slate players (not just the ~10 rostered)
    // so we write the complete playerScores map to a separate per-date file.
    const slateActualsFile = path.join(dataDir, 'slate_actuals.json');
    let slateActuals = {};
    try { if (fs.existsSync(slateActualsFile)) slateActuals = JSON.parse(fs.readFileSync(slateActualsFile, 'utf8')); } catch (e) {}
    slateActuals[date] = {};
    Object.entries(playerScores).forEach(([normName, score]) => {
      slateActuals[date][normName] = parseFloat(score.toFixed(2));
    });
    // Keep at most 60 dates to bound file size
    const allDates = Object.keys(slateActuals).sort().reverse();
    if (allDates.length > 60) allDates.slice(60).forEach(d => delete slateActuals[d]);
    await fs.promises.writeFile(slateActualsFile, JSON.stringify(slateActuals, null, 2));

    res.json({
      success: true,
      updated: updatedCount,
      playerCount: Object.keys(playerScores).length,
      gameCount: games.length,
      loadedGameCount: games.length - failedGames.length,
      failedGames,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to apply actuals: ' + err.message });
  }
});

// POST /api/ownership/import — accepts a pasted CSV of "PlayerName,Own%" rows and
// populates actualOwnership on all history entries for the given slate date.
// Supports: "Name,12.5", "Name,12.5%", "Name 12.5%", headers optional.
app.post('/api/ownership/import', async (req, res) => {
  try {
    const { date, csv } = req.body;
    if (!date || !csv) return res.status(400).json({ error: 'date and csv required' });

    // Parse each line into { normName, pct }
    const lines = csv.split(/\r?\n/).filter(l => l.trim());
    const ownership = {}; // normName → pct
    lines.forEach(line => {
      // Skip header lines
      if (/^(name|player|roster)/i.test(line.trim())) return;
      // Try comma-delimited first, then space-before-percentage
      let name, pctStr;
      if (line.includes(',')) {
        const parts = line.split(',');
        name = parts[0].trim();
        pctStr = parts[parts.length - 1].trim();
      } else {
        // "Logan Webb 32.5%" or "Logan Webb 32.5"
        const m = line.trim().match(/^(.+?)\s+([\d.]+)%?$/);
        if (m) { name = m[1].trim(); pctStr = m[2]; }
      }
      if (!name) return;
      // Strip DK name+id suffix like "(12345678)"
      name = name.replace(/\s*\(\d+\)\s*$/, '').trim();
      const pct = parseFloat((pctStr || '').replace('%', ''));
      if (!isNaN(pct) && pct >= 0 && pct <= 100) {
        ownership[normalizeName(name)] = pct;
      }
    });

    if (!Object.keys(ownership).length) {
      return res.status(400).json({ error: 'No valid ownership rows parsed. Expected format: "PlayerName,12.5" per line.' });
    }

    const history = await readHistory();
    let entriesUpdated = 0, playersMatched = 0;
    history.forEach(entry => {
      const eDate = entry.slateDate || entry.date?.substring(0, 10);
      if (eDate !== date || !Array.isArray(entry.lineup)) return;
      const actualOwnership = { ...(entry.actualOwnership || {}) };
      let matched = 0;
      entry.lineup.forEach(p => {
        const norm = normalizeName(p.name);
        const pct = ownership[norm];
        if (pct != null) { actualOwnership[p.name] = pct; matched++; }
      });
      if (matched > 0) {
        entry.actualOwnership = actualOwnership;
        entriesUpdated++;
        playersMatched = Math.max(playersMatched, matched);
      }
    });

    await writeHistory(history);
    res.json({ success: true, entriesUpdated, parsedPlayers: Object.keys(ownership).length, playersMatched });
  } catch (err) {
    res.status(500).json({ error: 'Failed to import ownership: ' + err.message });
  }
});

// ── DraftKings Contest Import ────────────────────────────────────────────────

// Normalize flexible DK CSV column names to canonical keys.
// DK has changed its export format several times; this handles known variants.
function normalizeDKCsvHeaders(headers) {
  const map = {};
  headers.forEach((h, i) => {
    // Strip BOM, surrounding quotes, and normalize to lowercase snake_case
    const k = h.replace(/^﻿/, '').trim().replace(/^"|"$/g, '').toLowerCase()
      .replace(/[\s()\-]/g, '_').replace(/_+/g, '_').replace(/_$/, '');
    if (/title|contest_name|contest_title/.test(k))                      map.title = i;
    if (/contest_key|contest_id|contestkey|contestid/.test(k))           map.contestId = i;
    if (/entry_key|entry_id|entrykey|entryid/.test(k))                   map.entryId = i;
    if (/^points$|^score$|^pts$|^dk_pts$|fantasy_points/.test(k))        map.points = i;
    if (/^place$|^rank$|^finish$|^placement$/.test(k))                   map.place = i;
    if (/entries_in_contest|total_entries|contest_entries|^entries$/.test(k)) map.totalEntries = i;
    if (/^winnings_non_ticket$|^winnings$/.test(k))                      map.winnings = i;
    if (/^winnings_ticket$/.test(k))                                      map.winningsTicket = i;
    if (/^sport$/.test(k))                                                map.sport = i;
    if (/date|start_date/.test(k))                                        map.date = i;
  });
  return map;
}

function parseDKContestCsv(csvText) {
  const lines = csvText.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  // Find the header line (first line with recognizable DK columns)
  const headers = lines[0].split(',');
  const col = normalizeDKCsvHeaders(headers);
  if (col.contestId == null || col.points == null) {
    const found = headers.map(h => h.replace(/^﻿/, '').trim()).join(', ');
    throw new Error(
      `Could not find required columns (Contest ID, Points). ` +
      `Headers found: [${found}]`
    );
  }

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    // Handle quoted fields with embedded commas
    const fields = [];
    let cur = '', inQ = false;
    for (const ch of lines[i]) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { fields.push(cur.trim()); cur = ''; }
      else { cur += ch; }
    }
    fields.push(cur.trim());

    if (fields.length < 3) continue;
    const get = idx => (idx != null && fields[idx] != null ? fields[idx].replace(/^"|"$/g, '').trim() : '');

    const sport = get(col.sport).toUpperCase();
    if (sport && sport !== 'MLB' && sport !== 'BASEBALL') continue; // skip non-MLB rows

    const rawDate = get(col.date);
    // Parse date — two formats DK uses:
    // "3/28/2026 7:05:00 PM" → M/D/YYYY
    // "2026-03-28 19:05:00"  → ISO YYYY-MM-DD
    let slateDate = '';
    if (rawDate) {
      const slash = rawDate.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (slash) {
        slateDate = `${slash[3]}-${slash[1].padStart(2,'0')}-${slash[2].padStart(2,'0')}`;
      } else {
        const iso = rawDate.match(/^(\d{4}-\d{2}-\d{2})/);
        if (iso) slateDate = iso[1];
      }
    }

    const points = parseFloat(get(col.points)) || 0;
    const place  = parseInt(get(col.place))    || null;
    const totalEntries = parseInt(get(col.totalEntries)) || null;
    const winningsCash   = parseFloat(get(col.winnings))       || 0;
    const winningsTicket = parseFloat(get(col.winningsTicket)) || 0;
    const winnings = winningsCash + winningsTicket;
    const contestId = get(col.contestId);
    const entryId   = get(col.entryId);
    const title     = get(col.title);

    if (!contestId && !points) continue;
    rows.push({ contestId, entryId, title, slateDate, points, place, totalEntries, winnings });
  }
  return rows;
}

// POST /api/contests/import-csv
// Body: { csv: string }
// Parses a DK "My Contests" export CSV, matches rows to history entries, updates them.
app.post('/api/contests/import-csv', async (req, res) => {
  try {
    const { csv } = req.body;
    if (!csv || typeof csv !== 'string') return res.status(400).json({ error: 'csv (string) required' });

    let rows;
    try { rows = parseDKContestCsv(csv); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    if (!rows.length) return res.status(400).json({ error: 'No MLB contest rows found in CSV. Make sure Sport column contains "MLB" and the file is a DraftKings My Contests export.' });

    const history = await readHistory();
    let matched = 0, created = 0, skipped = 0;
    const newEntries = [];

    for (const row of rows) {
      // --- Find matching history entry ---
      // Match by slateDate first; then score proximity.
      // Use actualPts when available (computed from box score), else projectedPts as rough proxy.
      const candidates = row.slateDate
        ? history.filter(h => (h.slateDate || h.date?.substring(0,10)) === row.slateDate)
        : [];

      let best = null, bestDelta = Infinity;
      for (const h of candidates) {
        // Skip entries already linked to a different contest entry
        const comparePts = h.actualPts ?? h.projectedPts ?? 0;
        const delta = Math.abs(comparePts - row.points);
        if (delta < bestDelta && delta < 8) { // 8-pt tolerance
          bestDelta = delta;
          best = h;
        }
      }

      if (best) {
        // Update existing entry
        if (row.contestId)   best.contestId    = row.contestId;
        if (row.entryId)     best.entryId      = row.entryId;
        if (row.title)       best.contestTitle = row.title;
        if (row.place)       best.finish       = row.place;
        if (row.totalEntries) best.entries     = row.totalEntries;
        if (row.winnings != null) best.winnings = row.winnings;
        if (row.points && !best.actualPts) best.actualPts = row.points;
        matched++;
      } else if (row.slateDate && row.points) {
        // Create a stub entry so the user can see the result even without a saved lineup
        newEntries.push({
          id: Date.now().toString(36) + Math.random().toString(36).slice(2,6) + created,
          date: new Date().toISOString(),
          slateDate: row.slateDate,
          slate: 'Main',
          contest: 'GPP',
          contestId: row.contestId,
          entryId: row.entryId,
          contestTitle: row.title,
          lineup: [],
          poolSnapshot: [],
          sources: [],
          projectedPts: null,
          projectedOwn: 0,
          salary: 0,
          actualPts: row.points,
          playerActuals: null,
          finish: row.place,
          entries: row.totalEntries,
          winnings: row.winnings,
          buyin: null,
          _stub: true,
        });
        created++;
      } else {
        skipped++;
      }
    }

    const allHistory = [...newEntries, ...history];
    const settings = await readHistorySettings();
    const pruned = pruneHistory(allHistory, settings);
    await writeHistory(pruned);
    _historyCache = null;

    // Surface most-recent contest size so the client can auto-update the portfolio
    // contestSize field. Uses the largest totalEntries on the most recent slate —
    // better than mean for capturing the actual field the user is competing in.
    let suggestedContestSize = null, suggestedContestDate = null;
    const validRows = rows.filter(r => r.totalEntries > 0 && r.slateDate);
    if (validRows.length) {
      const latestDate = validRows.map(r => r.slateDate).sort().reverse()[0];
      const latestRows = validRows.filter(r => r.slateDate === latestDate);
      suggestedContestSize = Math.max(...latestRows.map(r => r.totalEntries));
      suggestedContestDate = latestDate;
    }

    res.json({ success: true, rowsParsed: rows.length, matched, created, skipped, suggestedContestSize, suggestedContestDate });
  } catch (err) {
    res.status(500).json({ error: 'Import failed: ' + err.message });
  }
});

// GET /api/contests/:contestId — fetch public DK contest metadata + top scores if available
app.get('/api/contests/:contestId', async (req, res) => {
  const { contestId } = req.params;
  if (!/^\d+$/.test(contestId)) return res.status(400).json({ error: 'contestId must be numeric' });

  const result = { contestId, fetched: false };

  try {
    // Contest metadata (public, no auth)
    const metaRes = await apiFetch(
      `https://api.draftkings.com/contests/v1/contests/${contestId}?format=json`,
      { timeout: 10000 }
    );
    if (metaRes.ok) {
      const metaJson = await metaRes.json();
      const c = metaJson?.Contest || metaJson?.contest || {};
      result.title       = c.ContestName || c.name || c.title || null;
      result.entries     = c.Entries || c.entries || null;
      result.maxEntries  = c.MaximumEntries || c.maximumEntries || null;
      result.prizePool   = c.PayoutTotal || c.payoutTotal || c.totalPayoutAmount || null;
      result.draftGroupId = c.DraftGroupId || c.draftGroupId || null;
      result.startTime   = c.StartTime || c.startTime || null;
      result.fetched = true;
    }
  } catch (e) { /* metadata fetch failed — try standings anyway */ }

  try {
    // Standings / top scores (may require auth — try anyway, fail gracefully)
    const sbRes = await apiFetch(
      `https://api.draftkings.com/scores/v1/scores/${contestId}/standingsscoreboard?format=json`,
      { timeout: 10000 }
    );
    if (sbRes.ok) {
      const sbJson = await sbRes.json();
      const standings = sbJson?.Standings || sbJson?.standings || [];
      if (Array.isArray(standings) && standings.length > 0) {
        const scores = standings.map(s => parseFloat(s.FantasyPoints || s.fantasyPoints || s.Points || s.points || 0)).filter(s => s > 0).sort((a,b) => b-a);
        if (scores.length) {
          result.winningScore = scores[0];
          // Estimate cash line: the score at the payout cutoff (~20th percentile for top-20 GPPs)
          const cashIdx = Math.floor(scores.length * 0.20);
          result.cashLineScore = scores[cashIdx] || null;
          result.standingsCount = scores.length;
        }
      }
    }
  } catch (e) { /* standings unavailable without auth */ }

  res.json(result);
});

// Ownership calibration: compare projected own% vs actual own% across history entries
function calcOwnershipCalibration(history) {
  const pairs = [];
  history.forEach(entry => {
    if (!entry.actualOwnership || !Array.isArray(entry.lineup)) return;
    entry.lineup.forEach(p => {
      const actualOwn = entry.actualOwnership[p.name];
      if (actualOwn == null || (p.own || 0) <= 0) return;
      pairs.push({ name: p.name, projected: p.own, actual: actualOwn, error: actualOwn - p.own });
    });
  });
  if (pairs.length < 5) return null;
  const n = pairs.length;
  const avgError = pairs.reduce((s, p) => s + p.error, 0) / n;
  const rmse = Math.sqrt(pairs.reduce((s, p) => s + p.error * p.error, 0) / n);
  const mae = pairs.reduce((s, p) => s + Math.abs(p.error), 0) / n;
  // Correlation
  const avgP = pairs.reduce((s, p) => s + p.projected, 0) / n;
  const avgA = pairs.reduce((s, p) => s + p.actual, 0) / n;
  let sumXY = 0, sumXX = 0, sumYY = 0;
  pairs.forEach(p => {
    sumXY += (p.projected - avgP) * (p.actual - avgA);
    sumXX += (p.projected - avgP) ** 2;
    sumYY += (p.actual - avgA) ** 2;
  });
  const corr = sumXX > 0 && sumYY > 0 ? sumXY / Math.sqrt(sumXX * sumYY) : 0;
  // Bucket analysis: low (<10%), mid (10-25%), high (>25%) projected ownership
  const bucket = (min, max) => {
    const b = pairs.filter(p => p.projected >= min && p.projected < max);
    return b.length >= 3 ? { count: b.length, avgError: parseFloat((b.reduce((s, p) => s + p.error, 0) / b.length).toFixed(2)) } : null;
  };
  return {
    sampleSize: n,
    slates: [...new Set(history.filter(h => h.actualOwnership).map(h => h.slateDate || ''))].length,
    avgError: parseFloat(avgError.toFixed(2)),
    rmse: parseFloat(rmse.toFixed(2)),
    mae: parseFloat(mae.toFixed(2)),
    correlation: parseFloat(corr.toFixed(4)),
    lowOwn: bucket(0, 10),
    midOwn: bucket(10, 25),
    highOwn: bucket(25, 100),
    diagnosis: Math.abs(avgError) < 2 ? 'well_calibrated'
      : avgError > 0 ? 'under_projecting_ownership'
      : 'over_projecting_ownership'
  };
}

// GET /api/history/analysis — projection accuracy statistics for model tuning
app.get('/api/history/analysis', async (req, res) => {
  try {
  const history = await readHistory();

  // Recency decay: weight each observation by how recently it occurred.
  // Decay constant k=0.07 → half-life ≈ 10 days (n-day-old data worth 50% at n=10).
  // This prevents early-April calibration from being diluted by late-March openers,
  // and ensures the model tracks how projection accuracy evolves through the season.
  const today = new Date();
  const DECAY_K = 0.07;

  const pairs = [];
  history.forEach(entry => {
    if (!entry.playerActuals || !Array.isArray(entry.lineup)) return;
    // Calibration normalization: stored medians may already be scaled down by a
    // previous calibration run. We need raw (uncalibrated) projections to measure
    // how accurate ROO was vs actuals — not how accurate calibrated values were.
    // If the entry has no calibration stamps (pre-fix saves), assume scale=1.0
    // (uncalibrated), which is correct for all pre-April-10 entries.
    const calibBat = parseFloat(entry.calibBatterScale) || 1.0;
    const calibPit = parseFloat(entry.calibPitcherScale) || 1.0;
    // Compute recency weight: exp(-k * daysSince). Clamp daysSince to ≥0 so
    // future-dated entries (timezone edge cases) don't get weight > 1.
    const entryDate = new Date(entry.slateDate || entry.date);
    const daysSince = Math.max(0, (today - entryDate) / (1000 * 60 * 60 * 24));
    const weight = Math.exp(-DECAY_K * daysSince);

    entry.lineup.forEach(p => {
      const actual = entry.playerActuals[p.name];
      if (actual === undefined || actual === null) return;
      const storedMedian = p.median || 0;
      if (storedMedian <= 0) return;
      const isPitcher = (p.pos || '').includes('P');
      // Reverse-apply the stored calibration to get the original ROO projection.
      // For entries without calibration stamps (scale=1.0) this is a no-op.
      const scale = isPitcher ? calibPit : calibBat;
      const projected = scale > 0 ? storedMedian / scale : storedMedian;
      const rawPos = (p.pos || '').split('/')[0].trim();
      pairs.push({
        name: p.name, projected, actual,
        error: actual - projected,
        relError: (actual - projected) / projected,
        floor: p.floor || 0, ceiling: p.ceiling || 0,
        own: p.own || 0, order: p.order || 0,
        pos: isPitcher ? 'P' : 'BAT', rawPos, team: p.team || '',
        weight
      });
    });
  });

  // ── Lineup-level projection analysis (projectedPts vs actualPts per saved lineup) ──
  // Works without per-player actuals; less granular than player-level but still useful.
  const lineupPairs = history.filter(h => h.projectedPts > 0 && h.actualPts > 0);
  let lineupAnalysis = null;
  if (lineupPairs.length >= 3) {
    const avgProj  = lineupPairs.reduce((s, h) => s + h.projectedPts, 0) / lineupPairs.length;
    const avgAct   = lineupPairs.reduce((s, h) => s + h.actualPts,    0) / lineupPairs.length;
    const biasRel  = (avgAct - avgProj) / avgProj;
    const rmse     = Math.sqrt(lineupPairs.reduce((s, h) => s + ((h.actualPts - h.projectedPts) / h.projectedPts) ** 2, 0) / lineupPairs.length);
    // Spearman rank correlation at lineup level
    const sorted_lp = [...lineupPairs].sort((a, b) => a.projectedPts - b.projectedPts);
    const sorted_la = [...lineupPairs].sort((a, b) => a.actualPts    - b.actualPts);
    const lpRank = new Array(lineupPairs.length), laRank = new Array(lineupPairs.length);
    sorted_lp.forEach((h, r) => { lpRank[lineupPairs.indexOf(h)] = r; });
    sorted_la.forEach((h, r) => { laRank[lineupPairs.indexOf(h)] = r; });
    const spearman = (() => {
      const n = lineupPairs.length;
      const dSq = lineupPairs.reduce((s, _, i) => s + (lpRank[i] - laRank[i]) ** 2, 0);
      return 1 - (6 * dSq) / (n * (n * n - 1));
    })();
    lineupAnalysis = {
      count: lineupPairs.length,
      avgProjected: parseFloat(avgProj.toFixed(2)),
      avgActual:    parseFloat(avgAct.toFixed(2)),
      bias:         parseFloat(biasRel.toFixed(4)),
      rmse:         parseFloat(rmse.toFixed(4)),
      spearman:     parseFloat(spearman.toFixed(3)),
      calibrationFactor: parseFloat((avgAct / avgProj).toFixed(3)),
    };
  }

  // ── Contest performance analysis (works from stub data — no lineup/projections needed) ──
  // History entries use 'finish' for placement (not 'place' — that's the CSV column name).
  const contestEntries = history.filter(h => h.actualPts && (h.finish != null || h.place != null) && h.entries);
  let contestPerf = null;
  if (contestEntries.length >= 3) {
    const cashEntries    = contestEntries.filter(h => (h.winnings || 0) > 0);
    const totalWinnings  = contestEntries.reduce((s, h) => s + (h.winnings || 0), 0);
    const buyinEntries   = contestEntries.filter(h => h.buyin > 0);
    const totalBuyin     = buyinEntries.reduce((s, h) => s + h.buyin, 0);
    const finishOf = h => (h.finish ?? h.place ?? 0);
    const avgFinishPct   = contestEntries.reduce((s, h) => s + finishOf(h) / h.entries, 0) / contestEntries.length;
    const avgScore       = contestEntries.reduce((s, h) => s + h.actualPts, 0) / contestEntries.length;
    const top10pct       = contestEntries.filter(h => (finishOf(h) / h.entries) <= 0.10).length;
    const top20pct       = contestEntries.filter(h => (finishOf(h) / h.entries) <= 0.20).length;
    // Score distribution buckets
    const scores = contestEntries.map(h => h.actualPts).sort((a, b) => a - b);
    const p25 = scores[Math.floor(scores.length * 0.25)];
    const p50 = scores[Math.floor(scores.length * 0.50)];
    const p75 = scores[Math.floor(scores.length * 0.75)];
    contestPerf = {
      count:        contestEntries.length,
      cashRate:     parseFloat((cashEntries.length / contestEntries.length * 100).toFixed(1)),
      top10Rate:    parseFloat((top10pct / contestEntries.length * 100).toFixed(1)),
      top20Rate:    parseFloat((top20pct / contestEntries.length * 100).toFixed(1)),
      avgFinishPct: parseFloat((avgFinishPct * 100).toFixed(1)),
      avgScore:     parseFloat(avgScore.toFixed(2)),
      totalWinnings: parseFloat(totalWinnings.toFixed(2)),
      totalBuyin:   totalBuyin > 0 ? parseFloat(totalBuyin.toFixed(2)) : null,
      roi:          totalBuyin > 0 ? parseFloat(((totalWinnings - totalBuyin) / totalBuyin * 100).toFixed(1)) : null,
      scoreP25: parseFloat(p25.toFixed(2)), scoreP50: parseFloat(p50.toFixed(2)), scoreP75: parseFloat(p75.toFixed(2)),
    };
  }

  if (pairs.length < 5) {
    return res.json({
      sampleSize: pairs.length, sufficient: false,
      message: pairs.length === 0
        ? 'No player actuals found. Load actuals via "Load Actuals" for full per-player calibration.'
        : `Only ${pairs.length} player actuals — need 5+ for full calibration analysis.`,
      lineupAnalysis, contestPerf,
    });
  }

  function calcStats(arr) {
    if (!arr.length) return null;
    const n = arr.length;
    // Weighted bias and RMSE: recent slates contribute more than older ones.
    // Spearman rank correlation remains unweighted (rank-based metrics and
    // frequency-weighted ranks interact inconsistently at low n).
    const totalW = arr.reduce((s, p) => s + (p.weight || 1), 0);
    const bias = arr.reduce((s, p) => s + p.relError * (p.weight || 1), 0) / totalW;
    const rmse = Math.sqrt(arr.reduce((s, p) => s + (p.relError - bias) ** 2 * (p.weight || 1), 0) / totalW);
    // Spearman rank correlation (unweighted)
    const sorted_p = [...arr].sort((a, b) => a.projected - b.projected);
    const sorted_a = [...arr].sort((a, b) => a.actual - b.actual);
    const pRank = new Array(n), aRank = new Array(n);
    sorted_p.forEach((item, rank) => { pRank[arr.indexOf(item)] = rank; });
    sorted_a.forEach((item, rank) => { aRank[arr.indexOf(item)] = rank; });
    let d2 = 0;
    for (let i = 0; i < n; i++) d2 += Math.pow(pRank[i] - aRank[i], 2);
    const spearman = n > 2 ? 1 - (6 * d2) / (n * (n * n - 1)) : 0;
    // Effective sample size: sum of weights, normalized so 1 day-old data counts as 1.
    const effectiveN = parseFloat(totalW.toFixed(1));
    return {
      count: n,
      effectiveN,
      bias: parseFloat(bias.toFixed(4)),
      rmse: parseFloat(rmse.toFixed(4)),
      spearman: parseFloat(spearman.toFixed(4)),
      calibrationFactor: parseFloat((1 + bias).toFixed(4))
    };
  }

  const pitchers = pairs.filter(p => p.pos === 'P');
  const batters = pairs.filter(p => p.pos === 'BAT');
  const overall = calcStats(pairs);
  const pitcherStats = calcStats(pitchers);
  const batterStats = calcStats(batters);

  // Per-position breakdown for granular calibration
  const DK_POSITIONS = ['SP', 'RP', 'C', '1B', '2B', '3B', 'SS', 'OF'];
  const byPosition = {};
  DK_POSITIONS.forEach(pos => {
    const arr = pairs.filter(p => p.rawPos === pos);
    if (arr.length >= 5) byPosition[pos] = calcStats(arr);
  });

  const confidence = pairs.length >= 100 ? 'high' : pairs.length >= 40 ? 'medium' : pairs.length >= 20 ? 'low' : 'insufficient';

  // ── Simulation distribution calibration ──────────────────────────────────
  // For each player, compute p90 from their floor/median/ceiling distribution
  // then check what fraction of actuals exceeded that p90 threshold.
  // If the sim is well-calibrated, ~10% of actuals should exceed p90.
  // If it's consistently << 10%, tails are too fat (overconfident ceiling).
  // If >> 10%, tails are too tight (underconfident).
  let simCalibration = null;
  const simPairs = pairs.filter(p => p.ceiling > 0 && p.floor >= 0);
  if (simPairs.length >= 10) {
    let exceedP90 = 0, exceedP75 = 0, belowP10 = 0;
    simPairs.forEach(p => {
      // Reconstruct the asymmetric distribution the engine uses.
      // SIGMA_P90=1.28 matches engine.js samplePlayerScore — ceiling/floor are P90/P10.
      const leftStd = Math.max((p.projected - p.floor) / 1.28, 0.5);
      const rightStd = Math.max((p.ceiling - p.projected) / 1.28, 0.5);
      // P90 = median + 1.28 × rightStd = ceiling (when ceiling > projected + 0.64)
      const estP90 = p.projected + 1.28 * rightStd;
      // P75 ≈ median + 0.67 × rightStd
      const estP75 = p.projected + 0.67 * rightStd;
      // P10 ≈ median - 1.28 × leftStd
      const estP10 = p.projected - 1.28 * leftStd;
      if (p.actual > estP90) exceedP90++;
      if (p.actual > estP75) exceedP75++;
      if (p.actual < estP10) belowP10++;
    });
    const n = simPairs.length;
    simCalibration = {
      sampleSize: n,
      actualP90ExceedRate: parseFloat((exceedP90 / n * 100).toFixed(1)),
      expectedP90Rate: 10.0,
      actualP75ExceedRate: parseFloat((exceedP75 / n * 100).toFixed(1)),
      expectedP75Rate: 25.0,
      actualBelowP10Rate: parseFloat((belowP10 / n * 100).toFixed(1)),
      expectedP10Rate: 10.0,
      // Diagnosis
      tailDiagnosis: exceedP90 / n < 0.05 ? 'tails_too_fat'
        : exceedP90 / n > 0.18 ? 'tails_too_tight'
        : 'well_calibrated'
    };
  }

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
    byPosition,
    suggestion: {
      pitcherCalibration: pitcherStats?.calibrationFactor ?? 1.0,
      batterCalibration: batterStats?.calibrationFactor ?? 1.0,
      positionScales: Object.fromEntries(
        Object.entries(byPosition).map(([pos, s]) => [pos, s?.calibrationFactor ?? 1.0])
      ),
      confidence
    },
    simCalibration,
    ownershipCalibration: calcOwnershipCalibration(history),
    lineupAnalysis,
    contestPerf,
  });
  } catch (e) { res.status(500).json({ error: 'Failed to load history analysis' }); }
});

// ── Calibration Storage ──────────────────────────────────────────────────────

const calibrationFile = path.join(dataDir, 'calibration.json');
const DEFAULT_CALIBRATION = { pitcherScale: 1.0, batterScale: 1.0, positionScales: {}, updatedAt: null };

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

// ── Stadium GPS Coordinates (for weather lookups) ────────────────────────────
// Using exact stadium lat/lon instead of city names — city names were wrong for
// several parks (Oracle Park → "San Francisco" city center, Wrigley vs Guaranteed
// Rate both → "Chicago", NYM vs NYY both → "New York"). wttr.in accepts lat,lon.

const STADIUM_COORDS = {
  ARI: '33.4453,-112.0667',  // Chase Field, Phoenix
  ATL: '33.8908,-84.4677',   // Truist Park, Cumberland GA
  BAL: '39.2838,-76.6216',   // Camden Yards, Baltimore
  BOS: '42.3467,-71.0972',   // Fenway Park, Boston
  CHC: '41.9484,-87.6553',   // Wrigley Field, Chicago
  CWS: '41.8299,-87.6338',   // Guaranteed Rate Field, Chicago
  CIN: '39.0976,-84.5082',   // Great American Ball Park, Cincinnati
  CLE: '41.4962,-81.6852',   // Progressive Field, Cleveland
  COL: '39.7560,-104.9942',  // Coors Field, Denver
  DET: '42.3390,-83.0485',   // Comerica Park, Detroit
  HOU: '29.7573,-95.3555',   // Minute Maid Park, Houston
  KC:  '39.0517,-94.4803',   // Kauffman Stadium, Kansas City
  LAA: '33.8003,-117.8827',  // Angel Stadium, Anaheim
  LAD: '34.0739,-118.2400',  // Dodger Stadium, Los Angeles
  MIA: '25.7781,-80.2198',   // loanDepot park, Miami
  MIL: '43.0280,-87.9712',   // American Family Field, Milwaukee
  MIN: '44.9817,-93.2781',   // Target Field, Minneapolis
  NYM: '40.7571,-73.8458',   // Citi Field, Queens NY
  NYY: '40.8296,-73.9262',   // Yankee Stadium, Bronx NY
  OAK: '37.7516,-122.2005',  // Oakland Coliseum, Oakland (legacy)
  ATH: '38.5804,-121.5037',  // Sutter Health Park, Sacramento (Athletics 2025+)
  PHI: '39.9057,-75.1665',   // Citizens Bank Park, Philadelphia
  PIT: '40.4469,-80.0057',   // PNC Park, Pittsburgh
  SD:  '32.7076,-117.1570',  // Petco Park, San Diego
  SF:  '37.7786,-122.3893',  // Oracle Park, San Francisco
  SEA: '47.5914,-122.3325',  // T-Mobile Park, Seattle
  STL: '38.6226,-90.1928',   // Busch Stadium, St. Louis
  TB:  '27.7683,-82.6534',   // Tropicana Field, St. Petersburg
  TEX: '32.7473,-97.0842',   // Globe Life Field, Arlington TX
  TOR: '43.6415,-79.3892',   // Rogers Centre, Toronto
  WSH: '38.8730,-77.0074',   // Nationals Park, Washington DC
};

// Dome/retractable roof stadiums (weather less impactful)
const DOME_STADIUMS = ['MIA', 'TB', 'TOR', 'MIL', 'ARI', 'HOU', 'TEX', 'SEA', 'MIN'];

app.get('/api/stadiums', (req, res) => {
  res.set('Cache-Control', 'public, max-age=604800'); // stadium data is static — 7 days
  res.json({ coords: STADIUM_COORDS, domes: DOME_STADIUMS });
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

      // DraftKings uses 'ATH' for the Athletics; odds API maps them to 'OAK'.
      // Mirror the data so both abbreviations resolve correctly.
      if (homeAbbr === 'OAK') results['ATH'] = { ...results['OAK'] };
      if (awayAbbr === 'OAK') results['ATH'] = { ...results['OAK'] };
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

// Stadiums endpoint with orientation (wind-direction aware scoring)
app.get('/api/stadiums/extended', (req, res) => {
  res.set('Cache-Control', 'public, max-age=604800');
  res.json({ coords: STADIUM_COORDS, domes: DOME_STADIUMS, orientation: PARK_ORIENTATION });
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
    const allGames = schedule.dates?.[0]?.games || [];

    // Filter out postponed/suspended/cancelled games — they appear in the MLB schedule but
    // have no lineup, no batting order, and are never on the DK slate for that date.
    // Doubleheaders appear as two separate gamePk entries; both are passed through so the
    // client can cross-reference against the pool to determine which is on the DK slate.
    const games = allGames.filter(g => {
      const detail = g.status?.detailedState || '';
      return detail !== 'Postponed' && detail !== 'Suspended' && detail !== 'Cancelled';
    });

    const results = await Promise.all(games.map(async (game) => {
      const gamePk = game.gamePk;
      const homeAbbr = resolveTeamAbbr(game.teams?.home);
      const awayAbbr = resolveTeamAbbr(game.teams?.away);
      const homeProbable = game.teams?.home?.probablePitcher?.fullName || null;
      const awayProbable = game.teams?.away?.probablePitcher?.fullName || null;
      const gameTime = game.gameDate || '';
      const status = game.status?.abstractGameState || 'Preview';
      // Doubleheader metadata: gameNumber 1/2 lets the client display "Game 1" / "Game 2"
      const doubleHeader = game.doubleHeader || 'N'; // 'N'=single, 'S'=split DH, 'Y'=traditional DH
      const gameNumber = game.gameNumber || 1;

      let homeOrder = [], awayOrder = [], homeConfirmed = false, awayConfirmed = false;

      if (status === 'Live' || status === 'Final' || status === 'Preview') {
        try {
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
            // Require ≥8 batters per side — guards against a partial boxscore entry where
            // one player appears in the battingOrder array before the full lineup is submitted.
            // Both sides must be confirmed for the game to count as "confirmed."
            homeConfirmed = homeOrder.length >= 8;
            awayConfirmed = awayOrder.length >= 8;
          }
        } catch (e) { /* live data unavailable */ }
      }

      return {
        gamePk, homeTeam: homeAbbr, awayTeam: awayAbbr,
        homeProbable, awayProbable, gameTime, status,
        doubleHeader, gameNumber,
        homeOrder, awayOrder,
        homeConfirmed, awayConfirmed,
        // confirmed = both sides have submitted full lineups
        confirmed: homeConfirmed && awayConfirmed,
        // partialConfirmed = at least one side has a lineup (useful for early-release monitoring)
        partialConfirmed: homeConfirmed || awayConfirmed,
      };
    }));

    res.json({ success: true, date, games: results });
  } catch (err) {
    res.status(500).json({ error: 'Lineup fetch failed: ' + err.message });
  }
});

// ── Postponement Detection ──────────────────────────────────────────────────

app.get('/api/postponed/:date', async (req, res) => {
  try {
    const date = req.params.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });

    const schedRes = await apiFetch(`${MLB_API_BASE}/schedule?sportId=1&date=${date}&gameType=R`);
    if (!schedRes.ok) throw new Error(`MLB API ${schedRes.status}`);
    const schedule = await schedRes.json();
    const allGames = schedule.dates?.[0]?.games || [];

    const postponed = allGames
      .filter(g => {
        const detail = g.status?.detailedState || '';
        return detail === 'Postponed' || detail === 'Suspended' || detail === 'Cancelled';
      })
      .map(g => ({
        homeTeam: resolveTeamAbbr(g.teams?.home),
        awayTeam: resolveTeamAbbr(g.teams?.away),
        status: g.status?.detailedState || 'Unknown',
        gameTime: g.gameDate || '',
      }));

    res.json({ success: true, date, postponed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Statcast Data (Baseball Savant) ────────────────────────────────────────

const statcastCacheFile = path.join(dataDir, 'statcast_cache.json');

// RFC-4180 compliant CSV line parser. Baseball Savant wraps fields that contain
// commas (e.g. the column header "last_name, first_name") in double-quotes.
// A simple split(',') breaks those fields into two tokens, so row['last_name, first_name']
// is never found and every player is silently skipped — producing count=0.
function parseCSVLine(line) {
  const result = [];
  let i = 0, inQuote = false, field = '';
  while (i < line.length) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { field += '"'; i += 2; } // escaped ""
      else { inQuote = !inQuote; i++; }
    } else if (ch === ',' && !inQuote) {
      result.push(field.trim()); field = ''; i++;
    } else {
      field += ch; i++;
    }
  }
  result.push(field.trim());
  return result;
}

// Normalize a player name to the same key format used by the client pool lookup:
// lowercase, strip everything except a-z and spaces. Handles apostrophes, hyphens,
// diacritics (é→e handled by NFD decomposition), and suffix junk (Jr., III, etc.).
function normalizeStatcastName(raw) {
  return (raw || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip diacritics (é→e, ñ→n)
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\.?\b/g, '')
    .replace(/[^a-z ]/g, '')  // strip everything non-alpha
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchStatcastLeaderboard() {
  const year = new Date().getFullYear();
  // min=10 instead of min=q (qualified) so early-season data is included.
  // "Qualified" requires 502 PA — no one qualifies in April. min=10 catches
  // anyone with meaningful early-season at-bats.
  const url = `https://baseballsavant.mlb.com/leaderboard/custom?year=${year}&type=batter&filter=&sort=4&sortDir=desc&min=10&selections=xba,xslg,xwoba,exit_velocity_avg,launch_angle_avg,barrel_batted_rate,hard_hit_percent&chart=false&x=xba&y=xba&r=no&chartType=beeswarm&csv=true`;
  const resp = await apiFetch(url, { timeout: 20000, headers: { Accept: 'text/csv' } });
  if (!resp.ok) throw new Error(`Savant returned ${resp.status}`);
  const text = await resp.text();
  const lines = text.trim().split('\n');
  if (lines.length < 2) throw new Error('Empty Statcast response');
  const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase());
  const data = {};
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCSVLine(lines[i]);
    const row = {};
    headers.forEach((h, j) => row[h] = vals[j] || '');
    const name = row['last_name, first_name'] || row['player_name'] || '';
    if (!name) continue;
    // Convert "Last, First" → "First Last" then normalize to match pool key format
    const parts = name.split(',');
    const display = parts.length === 2 ? (parts[1].trim() + ' ' + parts[0].trim()) : name;
    const key = normalizeStatcastName(display);
    if (!key) continue;
    data[key] = {
      barrelRate: parseFloat(row['barrel_batted_rate'] || row['brl_percent'] || row['barrel%'] || 0) || 0,
      hardHitRate: parseFloat(row['hard_hit_percent'] || row['hard_hit%'] || 0) || 0,
      exitVelo: parseFloat(row['exit_velocity_avg'] || row['avg_exit_velocity'] || 0) || 0,
      launchAngle: parseFloat(row['launch_angle_avg'] || row['avg_launch_angle'] || 0) || 0,
      xwOBA: parseFloat(row['xwoba'] || row['est_woba'] || 0) || 0,
      xSLG: parseFloat(row['xslg'] || row['est_slg'] || 0) || 0,
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
        return res.json({ success: true, data: cached.data, cached: true, fetchedAt: cached.fetchedAt, count: Object.keys(cached.data || {}).length });
      }
    }
    const data = await fetchStatcastLeaderboard();
    const payload = { data, fetchedAt: new Date().toISOString(), count: Object.keys(data).length };
    fs.writeFileSync(statcastCacheFile, JSON.stringify(payload, null, 2));
    res.json({ success: true, ...payload });
  } catch (err) {
    if (fs.existsSync(statcastCacheFile)) {
      const cached = JSON.parse(fs.readFileSync(statcastCacheFile, 'utf8'));
      return res.json({ success: true, data: cached.data, cached: true, stale: true, fetchedAt: cached.fetchedAt, count: Object.keys(cached.data || {}).length, error: err.message });
    }
    res.status(500).json({ error: 'Statcast fetch failed: ' + err.message });
  }
});

// ── Pitcher Statcast Data (Baseball Savant) ────────────────────────────────

const pitcherStatcastCacheFile = path.join(dataDir, 'pitcher_statcast_cache.json');

async function fetchPitcherStatcastLeaderboard() {
  const year = new Date().getFullYear();
  // min=3 for pitchers — SPs make ~5 starts in a full month; 3 means at least 1 start.
  const url = `https://baseballsavant.mlb.com/leaderboard/custom?year=${year}&type=pitcher&filter=&sort=4&sortDir=desc&min=3&selections=p_k_percent,p_bb_percent,whiff_percent,fastball_avg_speed,hard_hit_percent,xera,xba&chart=false&x=xba&y=xba&r=no&chartType=beeswarm&csv=true`;
  const resp = await apiFetch(url, { timeout: 20000, headers: { Accept: 'text/csv' } });
  if (!resp.ok) throw new Error(`Savant returned ${resp.status}`);
  const text = await resp.text();
  const lines = text.trim().split('\n');
  if (lines.length < 2) throw new Error('Empty pitcher Statcast response');
  const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase());
  const data = {};
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCSVLine(lines[i]);
    const row = {};
    headers.forEach((h, j) => row[h] = vals[j] || '');
    const name = row['last_name, first_name'] || row['player_name'] || '';
    if (!name) continue;
    const parts = name.split(',');
    const display = parts.length === 2 ? (parts[1].trim() + ' ' + parts[0].trim()) : name;
    const key = normalizeStatcastName(display);
    if (!key) continue;
    data[key] = {
      kPercent: parseFloat(row['p_k_percent'] || row['k_percent'] || 0) || 0,
      bbPercent: parseFloat(row['p_bb_percent'] || row['bb_percent'] || 0) || 0,
      whiffRate: parseFloat(row['whiff_percent'] || 0) || 0,
      fastballVelo: parseFloat(row['fastball_avg_speed'] || row['avg_fastball_speed'] || 0) || 0,
      hardHitRate: parseFloat(row['hard_hit_percent'] || row['hard_hit%'] || 0) || 0,
      xERA: parseFloat(row['xera'] || row['est_era'] || 0) || 0,
      xBA: parseFloat(row['xba'] || row['est_ba'] || 0) || 0,
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
        return res.json({ success: true, data: cached.data, cached: true, fetchedAt: cached.fetchedAt, count: Object.keys(cached.data || {}).length });
      }
    }
    const data = await fetchPitcherStatcastLeaderboard();
    const payload = { data, fetchedAt: new Date().toISOString(), count: Object.keys(data).length };
    fs.writeFileSync(pitcherStatcastCacheFile, JSON.stringify(payload, null, 2));
    res.json({ success: true, ...payload });
  } catch (err) {
    if (fs.existsSync(pitcherStatcastCacheFile)) {
      const cached = JSON.parse(fs.readFileSync(pitcherStatcastCacheFile, 'utf8'));
      return res.json({ success: true, data: cached.data, cached: true, stale: true, fetchedAt: cached.fetchedAt, count: Object.keys(cached.data || {}).length, error: err.message });
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

// Proper CSV line parser that handles quoted fields containing commas
function parseCSVLine(line) {
  const result = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQuote = !inQuote; }
    else if (c === ',' && !inQuote) { result.push(cur.trim()); cur = ''; }
    else { cur += c; }
  }
  result.push(cur.trim());
  return result;
}

async function fetchCatcherFraming() {
  // Use 2025 full-season data for robust sample sizes (2026 too early in season)
  const url = 'https://baseballsavant.mlb.com/leaderboard/catcher-framing?type=catcher&seasonStart=2025&seasonEnd=2025&team=&min=q&sortColumn=rv_tot&sortDirection=desc&csv=true';
  const resp = await apiFetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    timeout: 20000
  });
  if (!resp.ok) throw new Error(`Savant framing HTTP ${resp.status}`);
  const text = await resp.text();
  if (text.trimStart().startsWith('<')) throw new Error('Savant framing returned HTML (bot block)');
  const lines = text.trim().split('\n');
  if (lines.length < 2) throw new Error('Empty framing CSV');
  const header = parseCSVLine(lines[0]);
  const nameIdx = header.indexOf('name');
  const rvIdx = header.indexOf('rv_tot');
  const pctIdx = header.indexOf('pct_tot');
  const pitchesIdx = header.indexOf('pitches');
  if (nameIdx < 0 || rvIdx < 0) throw new Error(`Missing framing CSV columns (found: ${header.slice(0,6).join(', ')})`);

  const data = {};
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCSVLine(lines[i]);
    const rawName = vals[nameIdx] || '';
    // Savant framing CSV stores "Last, First" — convert to "First Last"
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
  const resp = await apiFetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    timeout: 20000
  });
  if (!resp.ok) throw new Error(`Savant sprint HTTP ${resp.status}`);
  const text = await resp.text();
  if (text.trimStart().startsWith('<')) throw new Error('Savant sprint returned HTML (bot block)');
  const lines = text.trim().split('\n');
  if (lines.length < 2) throw new Error('Empty sprint CSV');
  const header = parseCSVLine(lines[0]);
  // Sprint CSV uses quoted "last_name, first_name" as a single column header
  const nameIdx = header.findIndex(h => h === 'last_name, first_name');
  const speedIdx = header.findIndex(h => h === 'sprint_speed');
  const boltsIdx = header.findIndex(h => h === 'bolts');
  const hpIdx = header.findIndex(h => h === 'hp_to_1b');
  if (nameIdx < 0 || speedIdx < 0) throw new Error(`Missing sprint CSV columns (found: ${header.slice(0,8).join(', ')})`);

  const data = {};
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCSVLine(lines[i]);
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

// ── Season Stats (MLB Stats API — batter & pitcher season rates) ─────────────
// Used as the anchor for internal projections when no ROO CSV is loaded.
// Fields match exactly what buildInternalProjections() in engine.js expects.

const seasonStatsCacheFile = path.join(dataDir, 'season_stats_cache.json');

async function fetchSeasonBatters(year) {
  // playerPool=All returns everyone with ≥1 PA; we filter to ≥20 PA client-side.
  const url = `${MLB_API_BASE}/stats?stats=season&group=hitting&season=${year}&sportIds=1&playerPool=All&limit=2000`;
  const resp = await apiFetch(url, { timeout: 20000 });
  if (!resp.ok) throw new Error(`MLB API batter stats ${resp.status}`);
  const json = await resp.json();
  const splits = json.stats?.[0]?.splits || [];
  const data = {};
  for (const s of splits) {
    const name = s.player?.fullName || '';
    if (!name) continue;
    const key = normalizeStatcastName(name);
    if (!key) continue;
    const st = s.stat || {};
    const pa = parseInt(st.plateAppearances) || 0;
    if (pa < 20) continue;
    data[key] = {
      pa,
      g:   parseInt(st.gamesPlayed) || 1,
      ab:  parseInt(st.atBats) || 0,
      h:   parseInt(st.hits) || 0,
      doubles: parseInt(st.doubles) || 0,
      triples: parseInt(st.triples) || 0,
      hr:  parseInt(st.homeRuns) || 0,
      rbi: parseInt(st.rbi) || 0,
      runs: parseInt(st.runs) || 0,
      bb:  parseInt(st.baseOnBalls) || 0,
      k:   parseInt(st.strikeOuts) || 0,
      sb:  parseInt(st.stolenBases) || 0,
      hbp: parseInt(st.hitByPitch) || 0,
    };
  }
  return data;
}

async function fetchSeasonPitchers(year) {
  const url = `${MLB_API_BASE}/stats?stats=season&group=pitching&season=${year}&sportIds=1&playerPool=All&limit=1000`;
  const resp = await apiFetch(url, { timeout: 20000 });
  if (!resp.ok) throw new Error(`MLB API pitcher stats ${resp.status}`);
  const json = await resp.json();
  const splits = json.stats?.[0]?.splits || [];
  const data = {};
  for (const s of splits) {
    const name = s.player?.fullName || '';
    if (!name) continue;
    const key = normalizeStatcastName(name);
    if (!key) continue;
    const st = s.stat || {};
    const gs = parseInt(st.gamesStarted) || 0;
    const g  = parseInt(st.gamesPlayed) || 0;
    // Include SPs (any starts) and relievers with ≥5 appearances
    if (gs < 1 && g < 5) continue;
    const ipRaw = parseFloat(st.inningsPitched) || 0;
    // MLB API uses .1 and .2 for fractional innings (1 out, 2 outs), not decimal
    const ipOuts = Math.floor(ipRaw) * 3 + Math.round((ipRaw % 1) * 10);
    const ip = ipOuts / 3;
    if (ip < 1) continue;
    data[key] = {
      g, gs,
      ip,
      k:   parseInt(st.strikeOuts) || 0,
      er:  parseInt(st.earnedRuns) || 0,
      h:   parseInt(st.hits) || 0,
      bb:  parseInt(st.baseOnBalls) || 0,
      w:   parseInt(st.wins) || 0,
      hbp: parseInt(st.hitBatsmen) || 0,
    };
  }
  return data;
}

app.get('/api/season-stats', async (req, res) => {
  try {
    if (fs.existsSync(seasonStatsCacheFile)) {
      const cached = JSON.parse(fs.readFileSync(seasonStatsCacheFile, 'utf8'));
      const age = Date.now() - new Date(cached.fetchedAt).getTime();
      if (age < 6 * 60 * 60 * 1000) {
        return res.json({ success: true, batters: cached.batters, pitchers: cached.pitchers,
          cached: true, fetchedAt: cached.fetchedAt,
          batterCount: Object.keys(cached.batters || {}).length,
          pitcherCount: Object.keys(cached.pitchers || {}).length });
      }
    }
    const year = new Date().getFullYear();
    const [batters, pitchers] = await Promise.all([fetchSeasonBatters(year), fetchSeasonPitchers(year)]);
    const payload = { batters, pitchers, fetchedAt: new Date().toISOString(),
      batterCount: Object.keys(batters).length, pitcherCount: Object.keys(pitchers).length };
    fs.writeFileSync(seasonStatsCacheFile, JSON.stringify(payload, null, 2));
    res.json({ success: true, ...payload });
  } catch (err) {
    if (fs.existsSync(seasonStatsCacheFile)) {
      const cached = JSON.parse(fs.readFileSync(seasonStatsCacheFile, 'utf8'));
      return res.json({ success: true, batters: cached.batters, pitchers: cached.pitchers,
        cached: true, stale: true, fetchedAt: cached.fetchedAt, error: err.message,
        batterCount: Object.keys(cached.batters || {}).length,
        pitcherCount: Object.keys(cached.pitchers || {}).length });
    }
    res.status(500).json({ error: 'Season stats fetch failed: ' + err.message });
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
        return res.json({ success: true, data: cached.data, cached: true, playerCount: Object.keys(cached.data || {}).length });
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

// ── Pitcher Handedness ─────────────────────────────────────────────────────────
// Fetches pitchHand (L/R) and batSide (L/R/S) for all active MLB players from
// the MLB Stats API roster endpoint. Used to enable platoon split adjustments in
// the optimizer without requiring the ROO CSV to include a `hand` column.
// Cache: 24 hours (handedness is static within a season).
let _pitcherHandsCache = null;
let _pitcherHandsCacheAt = 0;

app.get('/api/pitcher-hands', async (req, res) => {
  try {
    const now = Date.now();
    if (_pitcherHandsCache && now - _pitcherHandsCacheAt < 24 * 3600 * 1000) {
      return res.json({ success: true, hands: _pitcherHandsCache, cached: true });
    }

    const year = new Date().getFullYear();
    // Fetch all active roster players with handedness hydration.
    // sportId=1 = MLB, status=A = active roster
    const url = `${MLB_API_BASE}/sports/1/players?season=${year}&gameType=R&fields=people,id,fullName,pitchHand,batSide,primaryPosition,code`;
    const r = await apiFetch(url, { timeout: 15000 });
    if (!r.ok) throw new Error(`MLB API returned ${r.status}`);
    const data = await r.json();
    if (!data.people || !data.people.length) throw new Error('No player data returned');

    const hands = {};
    for (const p of data.people) {
      if (!p.fullName) continue;
      // Normalize name the same way the client normalizes pool names:
      // lowercase, strip diacritics, strip non-alpha, collapse spaces
      const norm = (p.fullName || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/\b(jr|sr|ii|iii|iv)\.?\b/g, '')
        .replace(/[^a-z ]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!norm) continue;

      // Store pitchHand for all players (batters use it for opposing pitcher lookup)
      // batSide stored as 'bats' prefix to distinguish
      if (p.pitchHand?.code) hands[norm] = p.pitchHand.code; // 'L', 'R', or 'S'
      // Also store batting side under 'bat:norm' key for future use
      if (p.batSide?.code) hands[`bat:${norm}`] = p.batSide.code;
    }

    _pitcherHandsCache = hands;
    _pitcherHandsCacheAt = now;
    res.json({ success: true, hands, total: Object.keys(hands).length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

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
      const homeAbbr = resolveTeamAbbr(game.teams?.home);
      const awayAbbr = resolveTeamAbbr(game.teams?.away);
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

app.get('/api/history/multiplier-analysis', async (req, res) => {
  const history = await readHistory();

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
app.post('/api/source-quality/update', async (req, res) => {
  const { date, sources } = req.body;
  if (!date || !Array.isArray(sources) || !sources.length) {
    return res.status(400).json({ error: 'date and sources[] required' });
  }

  // Item 7: Use full slate actuals (all ~300 players) instead of lineup-only actuals.
  // Full actuals are written by /api/actuals/apply to data/slate_actuals.json.
  // Fall back to history entry playerActuals for backward compatibility.
  const slateActualsFile = path.join(dataDir, 'slate_actuals.json');
  let allActuals = {};
  try {
    if (fs.existsSync(slateActualsFile)) {
      const sa = JSON.parse(fs.readFileSync(slateActualsFile, 'utf8'));
      if (sa[date]) allActuals = sa[date];
    }
  } catch (e) {}

  // Fallback: scrape from individual lineup history entries (old behavior, ~10 players only)
  if (!Object.keys(allActuals).length) {
    const history = await readHistory();
    history.forEach(entry => {
      if (!entry.playerActuals) return;
      const eDate = entry.slateDate || entry.date?.substring(0, 10);
      if (eDate !== date) return;
      Object.entries(entry.playerActuals).forEach(([name, score]) => {
        if (allActuals[name] === undefined || score > allActuals[name]) allActuals[name] = score;
      });
    });
  }

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
  if (DEBUG) {
    console.log('[debug] DEBUG mode ON — logging requests, fetches, and cache events.');
  } else {
    console.log('[info] Tip: set DEBUG=true (env var) to enable verbose logging.');
  }
});
