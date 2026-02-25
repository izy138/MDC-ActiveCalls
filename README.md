# Miami-Dade Fire Rescue — Live Dispatch Map

An interactive, real-time map of active Miami-Dade Fire Rescue calls using OpenStreetMap.

## Features

- **Live data** — Scrapes Miami-Dade Fire Rescue active calls; auto-refreshes every 60 seconds
- **Geocoded map** — Addresses plotted on a dark-theme map (OpenStreetMap + Leaflet)
- **Miami-Dade bounds** — Pan and zoom constrained to the county
- **Filters** — By incident type: Fire, Medical, Traffic, or All
- **Sidebar** — All active calls by zone; click a marker or card for details
- **Caching** — Geocode results cached in Turso (or in-memory) so the daily limit and cache survive server restarts

**Alternative:** A Google Maps version (with traffic layer) lives in `version-googlemaps/`. See that folder’s README to use it.

---

## Setup

### 1. Google API key (geocoding only)

The map uses **OpenStreetMap** in the browser (no key). You need a Google key only for **server-side geocoding** (address → lat/lng).

1. [Google Cloud Console](https://console.cloud.google.com) → create a project → enable **Geocoding API**
2. Create an API key under **Credentials**

### 2. Environment variables

Create a `.env` file in the project root:

```bash
GOOGLE_API_KEY=your_key_here
```

Optional (recommended for production):

```bash
# Persistent geocode cache + daily limit across restarts
TURSO_DATABASE_URL=libsql://your-db-name.turso.io
TURSO_AUTH_TOKEN=your_token_here

# Optional overrides (defaults shown)
GEOCODE_DAILY_LIMIT=200
RATE_LIMIT_PER_IP=10
RATE_LIMIT_GLOBAL=60
```

### 3. Turso (optional but recommended)

Without Turso, geocode results and the daily counter are in-memory only and reset on restart. With Turso:

1. Install [Turso CLI](https://docs.turso.tech/cli) and run: `turso db create miami-fire-geocodes`
2. Get the database URL and auth token from the Turso dashboard (or `turso db show miami-fire-geocodes`)
3. Add `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` to `.env`

On startup you’ll see the restored daily count, e.g. `Geocode budget restored: 13/200 used today`.

### 4. Run locally

```bash
npm install
npm start
```

Open **http://localhost:3001**

Development with auto-restart:

```bash
npm run dev
```

---

## Project structure

```
MDC-ActiveCalls/
├── server.js       # Express: scraper, geocoder, Turso, rate limits
├── index.html      # Map UI (Leaflet + OpenStreetMap)
├── package.json
├── .env            # Not committed; add GOOGLE_API_KEY, optional Turso vars
└── version-googlemaps/   # Optional Google Maps version (see its README)
```

---

## API

### `GET /api/calls`

Returns the current list of active calls with geocoded coordinates. Response is cached for 55 seconds and shared across all clients.

**Response shape:**

```json
{
  "calls": [
    {
      "rcvd": "17:31",
      "fc": "C2",
      "incType": "FIRE STRUCTURE",
      "address": "0000 BLOCK & NW NORTH RIVER DR",
      "units": "B05E02E35...",
      "zone": "NORTH",
      "id": "17:31-0000 BLOCK & NW NORTH RIVER DR",
      "coords": { "lat": 25.789, "lng": -80.221, "formattedAddress": "..." }
    }
  ],
  "lastUpdated": "2024-01-15T23:31:00.000Z",
  "total": 31,
  "geocodeBudget": { "used": 13, "limit": 200, "limited": false }
}
```

### `GET /health`

Status and diagnostics: database connection, geocode budget (used/limit/remaining), rate-limit config, cache status, uptime.

---

## Deploy

### Railway

1. Push the repo to GitHub.
2. [Railway](https://railway.app) → **New Project** → **Deploy from GitHub** → select repo.
3. In **Variables**, set at least:
   - `GOOGLE_API_KEY`
   - `PORT` = `3001` (if required)
   - Optional: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`
4. Restrict the Google API key to your Railway domain if desired.

### Render

1. [Render](https://render.com) → **New Web Service** → connect repo.
2. **Start Command:** `npm start`
3. Add env var: `GOOGLE_API_KEY` (and Turso vars if you use them).  
   Free tier may spin down after inactivity.

---

## Cost

| Item              | Cost                    |
|-------------------|-------------------------|
| Hosting (e.g. Railway) | ~$5/mo           |
| OpenStreetMap / Leaflet | Free (no key)   |
| Google Geocoding (with Turso cache) | ~$0–1/mo |
| **Rough total**   | **~$5–6/mo**            |

The map uses free OSM tiles. Only server-side geocoding uses Google; with Turso and the daily cap (default 200), usage stays low.

---

## Data source

**Miami-Dade Fire Rescue CAD Active Calls:**  
https://www.miamidade.gov/firecalls/calls.html

*This app uses publicly available data from Miami-Dade Fire Rescue. Addresses are approximate and incident types may change. Not for emergency use.*
