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



## Data source

**Miami-Dade Fire Rescue CAD Active Calls:**  
https://www.miamidade.gov/firecalls/calls.html

*This app uses publicly available data from Miami-Dade Fire Rescue. Addresses are approximate and incident types may change. Not for emergency use.*
