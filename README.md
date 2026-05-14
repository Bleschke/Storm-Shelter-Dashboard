# Storm Shelter Emergency Dashboard

## What was added in this version

- GRLevelX-style animated radar using cross-faded radar frames with manual frame controls and play/pause.
- Lightning detection display layer.
  - The browser can display strikes from a GeoJSON point feed.
  - The included Node server can receive local strike JSON at `POST /lightning` and push it to browsers by WebSocket.
  - This avoids scraping restricted lightning services.
- WebSocket live updates.
  - Run with Node/Docker and browse to `http://YOUR-SERVER:8787`.
  - The browser connects to `/ws` and receives pushed NWS alert changes instead of making frequent browser polling requests.
  - If WebSocket is unavailable, the browser falls back to a 5-minute alert refresh.

## Run locally with Node

```bash
npm install
npm start
```

Open:

```text
http://localhost:8787
```

## Run in Docker / Portainer

Use the included `docker-compose.yml` as a Portainer stack.

```bash
docker compose up -d --build
```

Open:

```text
http://YOUR-PI-OR-SERVER-IP:8787
```

## Lightning input examples

Send one strike:

```bash
curl -X POST http://localhost:8787/lightning \
  -H "Content-Type: application/json" \
  -d '{"lat":39.535,"lng":-76.348,"time":"2026-05-14T21:00:00Z","source":"local detector"}'
```

Send many strikes:

```bash
curl -X POST http://localhost:8787/lightning \
  -H "Content-Type: application/json" \
  -d '{"strikes":[{"lat":39.5,"lng":-76.3,"time":"now","source":"demo"}]}'
```

You can also put a URL to a GeoJSON `FeatureCollection` of `Point` features in the Lightning GeoJSON feed box.

## Notes

Radar frames use RainViewer public weather-map tiles for personal/educational display with an Iowa State Mesonet NEXRAD fallback. NWS alerts use api.weather.gov. Shelter sources remain FEMA NSS/OpenShelters and OpenStreetMap.

## v2.1 radar/lightning fix

This build changes the radar layer behavior:

- Uses NOAA/NWS MRMS ArcGIS export tiles for the crisp current radar layer. This remains visible at town/street zoom levels instead of only at CONUS-wide zoom.
- Keeps the animated RainViewer radar loop above it at lower opacity for motion/smoothing.
- Radar frame buttons now use simple icons: previous, play/pause, next.

Lightning now has a working default when run through the included Node/Docker server:

- `/api/lightning/wwlln` fetches the public WWLLN delayed KMZ feed and converts it to JSON points.
- You can still POST local detector strikes to `/lightning` or push them by WebSocket.
- If you open `index.html` directly from disk, the WWLLN server proxy is not available; run the Docker/Node server for lightning.



## Check-in deletion
Each Family / Team Check-In entry now includes a **Delete** button. Deleted entries are removed from browser local storage immediately and stay deleted after refresh.

## Radar mode selector

This build adds a **Radar mode** dropdown:

- **Animated radar loop**: uses the animated radar timeline with back/play/forward controls.
- **NEXRAD / NOAA current radar**: shows the current NOAA/NWS radar layer without animation.

The radar checkbox still turns radar on/off. The animation buttons are automatically disabled while NEXRAD/current mode is selected.


## Status descriptions

Shelter cards now translate FEMA/source status codes into human-readable text:

- O = Open — Shelter is currently open and operational.
- S = Standby — Shelter is on standby and may open if conditions worsen.
- C = Closed — Shelter is currently closed and unavailable.
- M = Monitoring — Shelter operational status is being monitored or has not been fully confirmed.
- Unknown = No operational status information is currently available.

Always verify shelter availability with local emergency management before traveling during a severe-weather event.


## Legal / Safety Disclaimer

This dashboard includes a visible unofficial-reference banner and a first-launch acknowledgement popup. It is intended only for planning, reference, and situational awareness. It is not an official emergency notification, dispatch, shelter-management, evacuation, medical, or life-safety system.

Use this software entirely at your own risk. Shelter, radar, lightning, route, map, GPS, alert, polygon, and weather information may be delayed, incomplete, unavailable, inaccurate, interrupted, corrupted, or outdated. Users must independently verify all information with official sources such as local emergency management, NOAA/NWS, FEMA, law enforcement, fire/rescue, shelter operators, and public-safety agencies.

The creator, distributor, host, operator, maintainer, contributors, and affiliated parties are not responsible or liable for user actions or decisions, or for any injury, illness, death, property damage, financial loss, data loss, emotional distress, business interruption, or other harm arising from use, misuse, inability to use, reliance on, or interpretation of this software or its data.

In an immediate or life-threatening emergency, call 911, seek safe shelter, and follow official instructions from emergency authorities and first responders.

This disclaimer is provided as general informational language and is not legal advice. Consider consulting a licensed attorney for jurisdiction-specific liability language.
