const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const NodeCache = require('node-cache');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

// ─── Cost & Rate Limit Config ────────────────────────────────────────────────
// Override any of these via Railway environment variables

const CONFIG = {
  // Max geocoding API calls per day before we stop geocoding new addresses
  // 200/day = ~$0.10/day worst case — well within Google's $200 free monthly credit
  GEOCODE_DAILY_LIMIT: parseInt(process.env.GEOCODE_DAILY_LIMIT || '200'),

  // Max requests to /api/calls per IP per minute
  RATE_LIMIT_PER_IP_PER_MIN: parseInt(process.env.RATE_LIMIT_PER_IP || '10'),

  // Max total requests to /api/calls per minute across ALL users
  RATE_LIMIT_GLOBAL_PER_MIN: parseInt(process.env.RATE_LIMIT_GLOBAL || '60'),
};

// ─── Turso DB via HTTP v2 (avoids /v1/jobs migration check on free plans) ─────
// Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in .env or Railway.
// Create DB: turso db create miami-fire-geocodes

let db = null; // { baseUrl, authToken, execute }

function tursoBaseUrl(url) {
  if (!url) return null;
  const u = url.replace(/^libsql:\/\//, 'https://');
  return u.startsWith('http') ? u : `https://${u}`;
}

async function tursoExecute(baseUrl, authToken, sql, args = []) {
  const body = {
    requests: [
      {
        type: 'execute',
        stmt: {
          sql,
          args: args.map((v) => (v == null ? { type: 'null' } : { type: 'text', value: String(v) })),
        },
      },
      { type: 'close' },
    ],
  };
  const res = await axios.post(`${baseUrl}/v2/pipeline`, body, {
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    },
    timeout: 10000,
  });
  const first = res.data?.results?.[0];
  if (!first || first.type !== 'ok') {
    const err = res.data?.results?.[0]?.response?.result?.error || res.data;
    throw new Error(err?.message || JSON.stringify(err || res.statusText));
  }
  const result = first.response?.result;
  if (!result) return { rows: [] };
  const cols = (result.cols || []).map((c) => c.name);
  const rows = (result.rows || []).map((row) => {
    const obj = {};
    row.forEach((cell, i) => {
      obj[cols[i]] = cell?.value ?? null;
    });
    return obj;
  });
  return { rows };
}

async function initDb() {
  const url = process.env.TURSO_DATABASE_URL;
  const token = process.env.TURSO_AUTH_TOKEN;
  if (!url || !token) {
    console.warn('⚠️  TURSO_DATABASE_URL or TURSO_AUTH_TOKEN not set — falling back to in-memory geocode cache only.');
    return;
  }

  const baseUrl = tursoBaseUrl(url);
  db = {
    baseUrl,
    authToken: token,
    async execute(opts) {
      const sql = typeof opts === 'string' ? opts : opts.sql;
      const args = typeof opts === 'string' ? [] : opts.args || [];
      return tursoExecute(baseUrl, token, sql, args);
    },
  };

  await db.execute(`
    CREATE TABLE IF NOT EXISTS geocodes (
      address    TEXT PRIMARY KEY,
      lat        REAL,
      lng        REAL,
      formatted  TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Create daily budget table — persists counter across restarts
  await db.execute(`
    CREATE TABLE IF NOT EXISTS geocode_budget (
      date   TEXT PRIMARY KEY,
      count  INTEGER DEFAULT 0
    )
  `);

  // Load today's count from DB into memory
  const today = new Date().toDateString();
  const { rows: budgetRows } = await db.execute({
    sql: 'SELECT count FROM geocode_budget WHERE date = ?',
    args: [today],
  });

  if (budgetRows.length > 0) {
    geocodeBudget = { date: today, count: budgetRows[0].count };
    console.log(`📊 Geocode budget restored: ${geocodeBudget.count}/${CONFIG.GEOCODE_DAILY_LIMIT} used today`);
  } else {
    geocodeBudget = { date: today, count: 0 };
  }

  const { rows } = await db.execute('SELECT COUNT(*) as count FROM geocodes');
  const count = rows[0]?.count ?? 0;
  console.log(`✅ Turso connected — ${count} addresses already cached in DB`);
}

// In-memory hot cache on top of Turso (1hr TTL) for speed
const memGeocodeCache = new NodeCache({ stdTTL: 3600 });

// Full call list cached for 55s — ALL visitors share this one response
const callCache = new NodeCache({ stdTTL: 55 });

// ─── Geocode Budget Tracker ──────────────────────────────────────────────────

let geocodeBudget = { date: new Date().toDateString(), count: 0 };

function geocodeAllowed() {
  const today = new Date().toDateString();
  if (geocodeBudget.date !== today) geocodeBudget = { date: today, count: 0 };
  return geocodeBudget.count < CONFIG.GEOCODE_DAILY_LIMIT;
}

function recordGeocodeCall() {
  const today = new Date().toDateString();
  if (geocodeBudget.date !== today) geocodeBudget = { date: today, count: 0 };
  geocodeBudget.count++;
  if (geocodeBudget.count >= CONFIG.GEOCODE_DAILY_LIMIT) {
    console.warn(`⚠️  Daily geocode limit (${CONFIG.GEOCODE_DAILY_LIMIT}) reached. No new geocoding until tomorrow.`);
  }
  // Persist to Turso so counter survives restarts
  if (db) {
    db.execute({
      sql: 'INSERT INTO geocode_budget (date, count) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET count = excluded.count',
      args: [today, geocodeBudget.count],
    }).catch(err => console.error('Failed to persist budget:', err.message));
  }
}

// ─── IP Rate Limiter ─────────────────────────────────────────────────────────

const ipRequestLog = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const timestamps = (ipRequestLog.get(ip) || []).filter(t => now - t < windowMs);
  timestamps.push(now);
  ipRequestLog.set(ip, timestamps);
  // Occasional cleanup to avoid memory leak
  if (Math.random() < 0.002) {
    for (const [key, times] of ipRequestLog.entries()) {
      if (now - Math.max(...times) > windowMs * 2) ipRequestLog.delete(key);
    }
  }
  return timestamps.length > CONFIG.RATE_LIMIT_PER_IP_PER_MIN;
}

// Global throttle (resets every minute)
let globalRequests = { count: 0, resetAt: Date.now() + 60000 };

function isGloballyThrottled() {
  const now = Date.now();
  if (now > globalRequests.resetAt) globalRequests = { count: 0, resetAt: now + 60000 };
  globalRequests.count++;
  return globalRequests.count > CONFIG.RATE_LIMIT_GLOBAL_PER_MIN;
}

function rateLimitMiddleware(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip;
  if (isGloballyThrottled()) {
    return res.status(429).json({ error: 'Server busy. Try again in a moment.', retryAfter: 60 });
  }
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please slow down.', retryAfter: 60 });
  }
  next();
}

// ─── Scraper ─────────────────────────────────────────────────────────────────

async function scrapeCalls() {
  const { data: html } = await axios.get('https://www.miamidade.gov/firecalls/calls.html', {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MiamiFireMap/1.0)' },
    timeout: 10000,
  });

  const $ = cheerio.load(html);
  const calls = [];

  $('h5, h4, h3, h2, strong, b, div').each((_, el) => {
    const text = $(el).text().trim();
    const zoneMatch = text.match(/^(NORTH|CENTRAL|SOUTH|EAST|MEDCOM)/i);
    if (!zoneMatch) return;
    const zone = zoneMatch[1].toUpperCase();
    const table = $(el).next('table').length
      ? $(el).next('table')
      : $(el).closest('div').next('div').find('table').first();

    table.find('tr').each((i, row) => {
      if (i === 0) return;
      const cells = $(row).find('td');
      if (cells.length < 4) return;
      const rcvd    = $(cells[0]).text().trim();
      const fc      = $(cells[1]).text().trim();
      const incType = $(cells[2]).text().trim();
      const address = $(cells[3]).text().trim();
      const units   = cells[4] ? $(cells[4]).text().trim() : '';
      if (address && incType) {
        calls.push({ rcvd, fc, incType, address, units, zone, id: `${rcvd}-${address}` });
      }
    });
  });

  if (calls.length === 0) {
    let currentZone = 'UNKNOWN';
    $('*').each((_, el) => {
      const text = $(el).text().trim();
      const m = text.match(/^(NORTH|CENTRAL|SOUTH|EAST|MEDCOM)\s*-\s*\d+\s*Calls?/i);
      if (m && $(el).children().length === 0) currentZone = m[1].toUpperCase();
    });
    $('table').each((_, table) => {
      $(table).find('tr').each((i, row) => {
        if (i === 0) return;
        const cells = $(row).find('td');
        if (cells.length < 4) return;
        const rcvd    = $(cells[0]).text().trim();
        const fc      = $(cells[1]).text().trim();
        const incType = $(cells[2]).text().trim();
        const address = $(cells[3]).text().trim();
        const units   = cells[4] ? $(cells[4]).text().trim() : '';
        if (address && incType) {
          calls.push({ rcvd, fc, incType, address, units, zone: currentZone, id: `${rcvd}-${address}` });
        }
      });
    });
  }

  return calls;
}

// ─── Geocoder (Turso-backed, with in-memory hot cache) ───────────────────────

async function geocodeAddress(rawAddress) {
  const cacheKey = rawAddress.toLowerCase().trim();

  // 1. In-memory hot cache first
  const memCached = memGeocodeCache.get(cacheKey);
  if (memCached !== undefined) return memCached;

  // 2. Turso DB (persists across restarts)
  if (db) {
    try {
      const { rows } = await db.execute({
        sql: 'SELECT lat, lng, formatted FROM geocodes WHERE address = ?',
        args: [cacheKey],
      });
      if (rows.length > 0) {
        const result = rows[0].lat
          ? { lat: rows[0].lat, lng: rows[0].lng, formattedAddress: rows[0].formatted }
          : null;
        memGeocodeCache.set(cacheKey, result);
        return result;
      }
    } catch (err) {
      console.error('Turso read error:', err.message);
    }
  }

  // 3. Google Geocoding API
  if (!geocodeAllowed()) {
    console.log(`Budget limit reached — skipping geocode for: ${rawAddress}`);
    return null;
  }

  let cleaned = rawAddress
    .replace(/(\d+)\s+BLOCK\s*&\s*/i, '$1 ')
    .replace(/\s*\/\s*/g, ' & ')
    .replace(/\s*&\s*/g, ' & ');

  const fullAddress = `${cleaned}, Miami-Dade County, FL`;

  try {
    recordGeocodeCall();
    const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: { address: fullAddress, key: GOOGLE_API_KEY },
      timeout: 5000,
    });

    if (response.data.results?.length > 0) {
      const { lat, lng } = response.data.results[0].geometry.location;
      const formatted = response.data.results[0].formatted_address;
      const result = { lat, lng, formattedAddress: formatted };

      if (db) {
        await db.execute({
          sql: 'INSERT OR REPLACE INTO geocodes (address, lat, lng, formatted) VALUES (?, ?, ?, ?)',
          args: [cacheKey, lat, lng, formatted],
        });
      }

      memGeocodeCache.set(cacheKey, result);
      return result;
    }
  } catch (err) {
    console.error(`Geocoding failed for "${rawAddress}":`, err.message);
  }

  // Cache failed lookups so we don't retry
  if (db) {
    try {
      await db.execute({
        sql: 'INSERT OR IGNORE INTO geocodes (address, lat, lng, formatted) VALUES (?, NULL, NULL, NULL)',
        args: [cacheKey],
      });
    } catch (err) { /* ignore */ }
  }
  memGeocodeCache.set(cacheKey, null);
  return null;
}

// ─── FHP Traffic Incidents Scraper ───────────────────────────────────────────
// Florida Highway Patrol live crash/road condition report. Lat/lng in page — no geocoding.
// Filter to Miami-Dade county only.

async function scrapeFHPIncidents() {
  const { data: html } = await axios.get(
    'https://trafficincidents.flhsmv.gov/SmartWebClient/CadView.aspx',
    {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MiamiFireMap/1.0)' },
      timeout: 15000,
    }
  );

  const $ = cheerio.load(html);
  const incidents = [];

  $('table tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 9) return;

    const county = $(cells[4]).text().trim().toUpperCase();
    if (!county.includes('MIAMI-DADE')) return;

    const incType   = $(cells[0]).text().trim();
    const received  = $(cells[1]).text().trim();
    const location  = $(cells[5]).text().trim();
    const remarks   = $(cells[6]).text().trim();
    const latText   = $(cells[7]).text().trim();
    const lngText   = $(cells[8]).text().trim();

    const lat = parseFloat(latText);
    const lng = parseFloat(lngText);

    if (!incType || !location) return;
    if (isNaN(lat) || isNaN(lng)) return;
    if (lat < 25.1 || lat > 26.2 || lng < -80.9 || lng > -80.0) return;

    incidents.push({
      source:   'FHP',
      id:       `fhp-${received}-${location}`.replace(/\s+/g, '-'),
      incType,
      address:  location,
      remarks,
      received,
      county,
      zone:     'FHP',
      units:    '',
      fc:       '',
      rcvd:     received ? received.split(' ')[1] || received : '',
      coords:   { lat, lng },
    });
  });

  return incidents;
}

// ─── App setup ────────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json());

// ─── API: Active calls ────────────────────────────────────────────────────────

app.get('/api/calls', rateLimitMiddleware, async (req, res) => {
  try {
    const cached = callCache.get('calls');
    if (cached) return res.json(cached);

    console.log('Fetching fresh data from Miami-Dade Fire + FHP...');

    const [fireResult, fhpResult] = await Promise.allSettled([
      scrapeCalls(),
      scrapeFHPIncidents(),
    ]);

    const calls = fireResult.status === 'fulfilled' ? fireResult.value : [];
    const fhp = fhpResult.status === 'fulfilled' ? fhpResult.value : [];

    if (fireResult.status === 'rejected')
      console.error('Miami-Dade scrape failed:', fireResult.reason?.message);
    if (fhpResult.status === 'rejected')
      console.error('FHP scrape failed:', fhpResult.reason?.message);

    // Geocode only MDFR addresses; FHP incidents have built-in lat/lng and never use the geocode API or count toward budget.
    console.log(`Fire calls: ${calls.length}, FHP incidents: ${fhp.length}. Geocode (MDFR only): ${geocodeBudget.count}/${CONFIG.GEOCODE_DAILY_LIMIT}`);

    const geocodedFire = await Promise.all(
      calls.map(async (call) => {
        const coords = await geocodeAddress(call.address);
        return { ...call, coords, source: 'MDFR' };
      })
    );

    const allCalls = [...geocodedFire, ...fhp];

    const result = {
      calls: allCalls,
      lastUpdated: new Date().toISOString(),
      total: allCalls.length,
      sources: { mdfr: geocodedFire.length, fhp: fhp.length },
      geocodeBudget: {
        used: geocodeBudget.count,
        limit: CONFIG.GEOCODE_DAILY_LIMIT,
        limited: !geocodeAllowed(),
        appliesTo: 'MDFR',
      },
    };

    callCache.set('calls', result);
    res.json(result);
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch calls', message: err.message });
  }
});

// ─── API: Health / status dashboard ──────────────────────────────────────────

app.get('/health', async (req, res) => {
  let dbStats = { connected: false };
  if (db) {
    try {
      const { rows } = await db.execute('SELECT COUNT(*) as count FROM geocodes');
      dbStats = { connected: true, cachedAddresses: rows[0].count };
    } catch (err) {
      dbStats = { connected: false, error: err.message };
    }
  }

  res.json({
    status: 'ok',
    database: dbStats,
    geocodeBudget: {
      used: geocodeBudget.count,
      limit: CONFIG.GEOCODE_DAILY_LIMIT,
      remaining: Math.max(0, CONFIG.GEOCODE_DAILY_LIMIT - geocodeBudget.count),
      limited: !geocodeAllowed(),
      appliesTo: 'MDFR',
    },
    rateLimits: {
      perIpPerMin: CONFIG.RATE_LIMIT_PER_IP_PER_MIN,
      globalPerMin: CONFIG.RATE_LIMIT_GLOBAL_PER_MIN,
      currentGlobalCount: globalRequests.count,
    },
    cacheActive: !!callCache.get('calls'),
    uptime: Math.floor(process.uptime()) + 's',
  });
});

// ─── Serve frontend ───────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  const frontendPath = path.join(__dirname, 'index.html');
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const backendUrl = `${protocol}://${host}`;
  let html = fs.readFileSync(frontendPath, 'utf8');
  html = html.replace(
    "const BACKEND_URL = window.BACKEND_URL || 'http://localhost:3001';",
    `const BACKEND_URL = '${backendUrl}';`
  );

  // Prevent caching
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.send(html);
});

app.use(express.static(__dirname));

// ─── Boot (wait for Turso before listening) ───────────────────────────────────

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Miami Fire Map running on port ${PORT}`);
    console.log(`Geocode daily limit: ${CONFIG.GEOCODE_DAILY_LIMIT} calls`);
    console.log(`Rate limits: ${CONFIG.RATE_LIMIT_PER_IP_PER_MIN}/min per IP, ${CONFIG.RATE_LIMIT_GLOBAL_PER_MIN}/min global`);
    if (!GOOGLE_API_KEY) console.warn('WARNING: GOOGLE_API_KEY not set. Geocoding will fail.');
  });
});
