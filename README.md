# Miami-Dade Fire Rescue — Live Dispatch Map

An interactive, real-time map of active Miami-Dade Fire Rescue calls using OpenStreetMap.

## Features

- **Live data** — Scrapes Miami-Dade Fire Rescue active calls; auto-refreshes every 60 seconds
- **Geocoded map** — Addresses plotted on a dark-theme map (OpenStreetMap + Leaflet)
- **Miami-Dade bounds** — Pan and zoom constrained to the county
- **Filters** — By incident type: Fire, Medical, Traffic, FHP (highway patrol only), or All
- **Sidebar** — All active calls by zone; click a marker or card for details
- **Caching** — Geocode results cached in Turso (or in-memory) so the daily limit and cache survive server restarts

**Alternative:** A Google Maps version (with traffic layer) lives in `version-googlemaps/`. See that folder’s README to use it.

## Data source

**Miami-Dade Fire Rescue CAD Active Calls:**  
https://www.miamidade.gov/firecalls/calls.html

**Florida Highway Patrol — Live Traffic Crash and Road Condition Report (FLHSMV)**  
https://trafficincidents.flhsmv.gov/SmartWebClient/CadView.aspx

### FLHSMV / FHP integration

The map merges **Florida Highway Patrol** incidents with MDFR calls. FHP data is scraped from the FLHSMV live report and filtered to Miami-Dade only. Incidents include built-in **latitude and longitude**, so no geocoding is used for FHP — zero extra API cost. FHP primarily covers highways (e.g. I-95, SR-826, Turnpike); MDFR covers local street-level fire and medical calls. Together the two sources give a fuller picture of what’s active in the county.

On the map, FHP incidents use **purple markers**, a dedicated **FHP** filter in the sidebar, and their own zone section. Popups show a source badge (MDFR or FHP) and, for FHP, a **remarks** field (e.g. “ROADBLOCK”, “PARTIALLY BLOCKING RIGHT LANE”). Both sources are fetched in parallel; if one fails, the other still loads.

*This app uses publicly available data from Miami-Dade Fire Rescue and FLHSMV. Addresses are approximate and incident types may change. Not for emergency use.*
