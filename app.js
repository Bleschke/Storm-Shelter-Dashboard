'use strict';

const FEMA_BASE = 'https://gis.fema.gov/arcgis/rest/services/NSS/FEMA_NSS/MapServer';
const FEMA_OPEN = 'https://gis.fema.gov/arcgis/rest/services/NSS/OpenShelters/MapServer/0/query';
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const NWS_ALERTS = 'https://api.weather.gov/alerts/active';
const NWS_MAX_ZONE_GEOMETRIES = 30;
const OSRM = 'https://router.project-osrm.org/route/v1/driving';
const RADAR_TILES = 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png';
const NOAA_RADAR_EXPORT = 'https://mapservices.weather.noaa.gov/eventdriven/rest/services/radar/radar_base_reflectivity/MapServer/export';
const RAINVIEWER_API = 'https://api.rainviewer.com/public/weather-maps.json';
const RAINVIEWER_TILE = 'https://tilecache.rainviewer.com';

let map, userMarker, radiusCircle, routeLayer, radarLayer, closuresLayer, lightningLayer, radarCurrentLayer;
let baseLayers = {}, markers = [], alertLayers = [];
let radarFrames = [], radarFrameIndex = 0, radarTimer = null, radarPlaying = true, radarFallbackLayer = null;
let liveSocket = null, lightningStrikes = [];
let currentCenter = null, allShelters = [], activeAlerts = [];

const $ = id => document.getElementById(id);

function initLegalDisclaimer() {
  const modal = $('legalDisclaimerModal');
  const acceptBtn = $('legalAcceptBtn');
  if (!modal || !acceptBtn) return;
  const accepted = localStorage.getItem('stormShelterLegalDisclaimerAccepted') === 'true';
  modal.style.display = accepted ? 'none' : 'flex';
  acceptBtn.addEventListener('click', () => {
    localStorage.setItem('stormShelterLegalDisclaimerAccepted', 'true');
    modal.style.display = 'none';
  });
}


window.addEventListener('load', startDashboard);

function startDashboard() {
  try {
    setDiag('Starting JavaScript…');
    initLegalDisclaimer();
    if (!window.L) throw new Error('Leaflet did not load. Internet access is required for the CDN map library.');
    initMap();
    bindButtons();
    renderCheckins();
    bindCheckinDeleteHandler();
    updateNetwork();
    tickClock();
    setInterval(tickClock, 1000);
    setInterval(() => { if (!liveSocket || liveSocket.readyState !== WebSocket.OPEN) { if (currentCenter) loadAlerts(currentCenter.lat, currentCenter.lng); } }, 300000);
    window.addEventListener('online', updateNetwork);
    window.addEventListener('offline', updateNetwork);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js?v=12').catch(() => {});
    setStatus('Ready. Buttons are connected. Use My Location or search a city/ZIP.');
    setDiag('Dashboard JS loaded successfully. Version 25 expanded legal liability disclaimer + status descriptions.');
  } catch (err) {
    console.error(err);
    setStatus('Startup error: ' + err.message);
    setDiag('Startup error: ' + err.stack);
  }
}

function bindButtons() {
  const bindings = {
    locateBtn: locateUser,
    searchManualBtn: geocodeManualLocation,
    refreshBtn: () => currentCenter ? loadShelters(currentCenter.lat, currentCenter.lng) : setStatus('Choose a location first.'),
    alertsBtn: () => currentCenter ? loadAlerts(currentCenter.lat, currentCenter.lng) : setStatus('Choose a location first.'),
    nearestBtn: routeToBest,
    dashboardBtn: toggleDashboard,
    addCheckBtn: addCheckin,
    sendSituationBtn: sendSituation,
    exportBtn: exportJson,
    radarBackBtn: () => stepRadar(-1),
    radarPlayBtn: toggleRadarPlayback,
    radarForwardBtn: () => stepRadar(1),
    connectWsBtn: connectLiveSocket,
    disconnectWsBtn: disconnectLiveSocket
  };
  Object.entries(bindings).forEach(([id, fn]) => {
    const node = $(id);
    if (!node) return setDiag(`Missing button: ${id}`);
    node.addEventListener('click', ev => { ev.preventDefault(); fn(); });
  });

  $('baseMap').addEventListener('change', switchBaseMap);
  $('layerRadar').addEventListener('change', toggleRadar);
  $('radarMode').addEventListener('change', applyRadarMode);
  $('layerLightning').addEventListener('change', toggleLightning);
  $('lightningFeed').addEventListener('change', () => { if ($('layerLightning').checked) refreshLightningFeed(); });
  $('layerAlerts').addEventListener('change', renderAlerts);
  $('layerTraffic').addEventListener('change', toggleClosures);
  ['filterOpen','filterStorm','filterAda','filterPets','avoidAlerts'].forEach(id => {
    $(id).addEventListener('change', () => renderShelters(applyFilters(allShelters)));
  });
  $('manualLocation').addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); geocodeManualLocation(); }
  });
}

function initMap() {
  map = L.map('map', { preferCanvas: true }).setView([39.8283, -98.5795], 4);
  baseLayers.street = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' });
  baseLayers.satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Esri, Maxar, Earthstar Geographics' });
  baseLayers.terrain = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: 'OpenTopoMap' });
  baseLayers.street.addTo(map);
  radarLayer = L.layerGroup();
  radarFallbackLayer = L.tileLayer(RADAR_TILES, { opacity: 0.55, zIndex: 350, maxZoom: 19, maxNativeZoom: 8, attribution: 'NEXRAD via Iowa State Mesonet' });
  radarCurrentLayer = L.noaaRadarLayer(NOAA_RADAR_EXPORT, { opacity: 0.68, zIndex: 355, attribution: 'NOAA/NWS MRMS radar' });
  lightningLayer = L.layerGroup();
  closuresLayer = L.layerGroup();
  initRadarAnimation();
  setTimeout(() => map.invalidateSize(), 250);
}

function toggleDashboard() {
  document.body.classList.toggle('dashboard');
  setTimeout(() => map.invalidateSize(), 250);
}

function updateNetwork() { $('networkChip').textContent = `Network: ${navigator.onLine ? 'online' : 'offline'}`; }
function tickClock() { $('clockChip').textContent = new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' }); }
function setStatus(msg) { $('statusText').textContent = msg; }
function setDiag(msg) { const d = $('diagnostics'); if (d) d.textContent = msg; }

function getStatusDescription(status) {
  const raw = (status || '').toString().trim();
  const normalized = raw.toUpperCase();
  switch (normalized) {
    case 'O':
      return { code: raw || 'O', short: 'Open', long: 'Shelter is currently open and operational.' };
    case 'S':
      return { code: raw || 'S', short: 'Standby', long: 'Shelter is on standby and may open if conditions worsen.' };
    case 'C':
      return { code: raw || 'C', short: 'Closed', long: 'Shelter is currently closed and unavailable.' };
    case 'M':
      return { code: raw || 'M', short: 'Monitoring', long: 'Shelter operational status is being monitored or has not been fully confirmed.' };
    case 'HOURS LISTED':
      return { code: raw, short: 'Hours Listed', long: 'This listing includes hours information, but live shelter availability is not confirmed.' };
    case 'UNKNOWN':
    case '':
      return { code: raw, short: 'Unknown', long: 'No operational status information is currently available.' };
    default:
      return { code: raw, short: raw || 'Unknown', long: 'Status value reported by the source; confirm current availability with local emergency management before relying on this shelter.' };
  }
}

function statusHtml(status) {
  const info = getStatusDescription(status);
  const codeText = info.code && info.code.toUpperCase() !== info.short.toUpperCase() ? ` <span class="statusCode">(${escapeHtml(info.code)})</span>` : '';
  return `<div class="shelter-status"><strong>Status:</strong> ${escapeHtml(info.short)}${codeText}<div class="status-description">${escapeHtml(info.long)}</div></div>`;
}

function locateUser() {
  if (!navigator.geolocation) return setStatus('Geolocation is not supported. Enter a city or ZIP manually.');
  setStatus('Getting your location…');
  navigator.geolocation.getCurrentPosition(
    pos => {
      const lat = pos.coords.latitude, lng = pos.coords.longitude;
      setCenter(lat, lng, 'Your location');
      loadEverything(lat, lng);
    },
    err => setStatus(`Location access failed: ${err.message}. Try manual search, such as Bel Air, MD.`),
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
  );
}

async function geocodeManualLocation() {
  const q = $('manualLocation').value.trim();
  if (!q) return setStatus('Enter a city, ZIP, or address first.');
  setStatus('Finding that location…');
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(q)}`;
    const data = await fetchJson(url);
    if (!data.length) return setStatus('Location not found. Try city + state, such as “Bel Air, MD”.');
    const lat = Number(data[0].lat), lng = Number(data[0].lon);
    setCenter(lat, lng, data[0].display_name || q);
    await loadEverything(lat, lng);
  } catch (err) {
    setStatus('Location search failed: ' + err.message);
  }
}

function setCenter(lat, lng, label) {
  currentCenter = { lat, lng };
  sendLiveSubscription();
  map.setView([lat, lng], 10);
  if (userMarker) userMarker.remove();
  userMarker = L.marker([lat, lng]).addTo(map).bindPopup(escapeHtml(label || 'Search location'));
}

async function loadEverything(lat, lng) {
  await Promise.allSettled([loadShelters(lat, lng), loadAlerts(lat, lng)]);
}

async function loadShelters(lat, lng) {
  clearShelterMarkers();
  const radius = Number($('radiusMiles').value || 25);
  setStatus(`Searching shelters within ${radius} miles…`);
  if (radiusCircle) radiusCircle.remove();
  radiusCircle = L.circle([lat, lng], { radius: radius * 1609.344, color: '#60a5fa', fillOpacity: 0.05 }).addTo(map);

  const settled = await Promise.allSettled([
    queryFemaLayers(lat, lng, radius),
    queryOpenFema(lat, lng, radius),
    queryOsmShelters(lat, lng, radius)
  ]);
  const errors = settled.filter(x => x.status === 'rejected').map(x => x.reason.message).join(' | ');
  allShelters = settled.flatMap(x => x.status === 'fulfilled' ? x.value : []);
  allShelters = dedupe(allShelters).map(s => ({ ...s, score: scoreShelter(s) })).sort((a,b) => b.score - a.score || a.distanceMiles - b.distanceMiles);
  localStorage.setItem('lastShelters', JSON.stringify({ center: currentCenter, ts: Date.now(), items: allShelters }));
  $('cacheChip').textContent = `Cache: ${allShelters.length} shelters saved`;
  renderShelters(applyFilters(allShelters));
  setStatus(`Found ${allShelters.length} shelter/location records.${errors ? ' Some feeds failed: ' + errors : ''}`);
}

async function queryFemaLayers(lat, lng, radiusMiles) {
  const meters = Math.round(radiusMiles * 1609.344);
  const layers = [0,1,2,3,4,5,6,7];
  const output = [];
  await Promise.all(layers.map(async layer => {
    const url = `${FEMA_BASE}/${layer}/query?f=json&where=1%3D1&outFields=*&returnGeometry=true&geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&distance=${meters}&units=esriSRUnit_Meter&outSR=4326`;
    const json = await fetchJson(url);
    (json.features || []).forEach(f => {
      const attrs = lowerKeys(f.attributes || {});
      const geom = f.geometry || {};
      const slat = Number(geom.y ?? attrs.latitude ?? attrs.lat);
      const slng = Number(geom.x ?? attrs.longitude ?? attrs.lon ?? attrs.lng);
      if (Number.isFinite(slat) && Number.isFinite(slng)) output.push(normalizeShelter(attrs, slat, slng, 'FEMA NSS', 'fema', lat, lng));
    });
  }));
  return output;
}

async function queryOpenFema(lat, lng, radiusMiles) {
  const meters = Math.round(radiusMiles * 1609.344);
  const url = `${FEMA_OPEN}?f=json&where=1%3D1&outFields=*&returnGeometry=true&geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&distance=${meters}&units=esriSRUnit_Meter&outSR=4326`;
  const json = await fetchJson(url);
  return (json.features || []).map(f => {
    const attrs = lowerKeys(f.attributes || {});
    const geom = f.geometry || {};
    return normalizeShelter(attrs, Number(geom.y), Number(geom.x), 'FEMA Open Shelters', 'open', lat, lng);
  }).filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lng));
}

async function queryOsmShelters(lat, lng, radiusMiles) {
  const meters = Math.round(radiusMiles * 1609.344);
  const q = `[out:json][timeout:25];(node(around:${meters},${lat},${lng})["amenity"="shelter"];way(around:${meters},${lat},${lng})["amenity"="shelter"];relation(around:${meters},${lat},${lng})["amenity"="shelter"];node(around:${meters},${lat},${lng})["emergency"~"shelter|assembly_point|safe_room"];way(around:${meters},${lat},${lng})["emergency"~"shelter|assembly_point|safe_room"];);out center tags;`;
  const json = await fetchJson(OVERPASS, { method: 'POST', body: q, headers: { 'Content-Type': 'text/plain' } });
  return (json.elements || []).map(e => {
    const tags = e.tags || {};
    const slat = Number(e.lat ?? e.center?.lat), slng = Number(e.lon ?? e.center?.lon);
    return {
      id: `osm-${e.type}-${e.id}`,
      name: tags.name || tags.operator || 'OpenStreetMap shelter',
      address: osmAddress(tags),
      lat: slat, lng: slng, source: 'OpenStreetMap', kind: 'osm',
      status: tags.opening_hours ? 'Hours listed' : 'Unknown',
      capacity: tags.capacity || '', raw: tags,
      distanceMiles: haversine(lat, lng, slat, slng)
    };
  }).filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lng));
}

function normalizeShelter(attrs, lat, lng, source, kind, userLat, userLng) {
  return {
    id: `${source}-${first(attrs, ['objectid','facilityid','shelter_id','id']) || lat + ',' + lng}`,
    name: first(attrs, ['shelter_name','facility_name','name','org_name','site_name','location_name','building_name']) || 'Shelter location',
    address: makeAddress(attrs),
    lat, lng, source, kind,
    status: first(attrs, ['status','shelter_status','open_status','operational_status']) || 'Unknown',
    capacity: first(attrs, ['capacity','total_capacity','population_capacity']) || '',
    raw: attrs,
    distanceMiles: haversine(userLat, userLng, lat, lng)
  };
}

function makeAddress(a) {
  const line1 = first(a, ['address','address1','address_1','street_address','location_address','physical_address','addr1','street','street1']);
  const city = first(a, ['city','municipality','community']);
  const state = first(a, ['state','st','state_abbr']);
  const zip = first(a, ['zip','zipcode','postal_code','zip_code']);
  return [line1, city, state, zip].filter(Boolean).join(', ') || 'Address not provided by source';
}

function osmAddress(t) {
  const line1 = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
  return [line1, t['addr:city'], t['addr:state'], t['addr:postcode']].filter(Boolean).join(', ') || 'Address not provided by source';
}

function first(obj, keys) {
  for (const key of keys) {
    const val = obj[key];
    if (val !== undefined && val !== null && String(val).trim()) return String(val).trim();
  }
  return '';
}
function lowerKeys(obj) { return Object.fromEntries(Object.entries(obj).map(([k,v]) => [String(k).toLowerCase(), v])); }

function scoreShelter(s) {
  let score = 100 - Math.min(70, s.distanceMiles * 2.5);
  const text = `${JSON.stringify(s.raw)} ${s.name} ${s.status}`.toLowerCase();
  if (s.kind === 'open') score += 30;
  if (/open|active|available/.test(text)) score += 18;
  if (/storm|tornado|safe room|hurricane|shelter/.test(text)) score += 12;
  if (/ada|accessible|wheelchair/.test(text)) score += 7;
  if (/pet|animal/.test(text)) score += 5;
  if ($('avoidAlerts').checked && pointInAnyAlert(s.lat, s.lng)) score -= 35;
  return Math.round(score);
}

function applyFilters(items) {
  return items.filter(s => {
    const text = `${JSON.stringify(s.raw)} ${s.name} ${s.status}`.toLowerCase();
    if ($('filterOpen').checked && !/open|active|available/.test(text)) return false;
    if ($('filterStorm').checked && !/storm|tornado|safe room|hurricane/.test(text)) return false;
    if ($('filterAda').checked && !/ada|accessible|wheelchair/.test(text)) return false;
    if ($('filterPets').checked && !/pet|animal/.test(text)) return false;
    return true;
  }).map(s => ({ ...s, score: scoreShelter(s) })).sort((a,b) => b.score - a.score || a.distanceMiles - b.distanceMiles);
}

function renderShelters(items) {
  clearShelterMarkers();
  const results = $('results');
  results.innerHTML = '';
  if (!items.length) {
    results.innerHTML = '<section class="result">No shelters matched the current filters or the selected radius.</section>';
    return;
  }
  const group = L.featureGroup();
  items.forEach((s, i) => {
    const color = s.kind === 'open' ? '#22c55e' : s.kind === 'osm' ? '#f59e0b' : '#38bdf8';
    const marker = L.circleMarker([s.lat, s.lng], { radius: 8, color, fillColor: color, fillOpacity: 0.85, weight: 2 }).addTo(map).bindPopup(popupHtml(s));
    markers.push(marker); group.addLayer(marker);
    const article = document.createElement('article');
    article.className = 'result';
    article.innerHTML = `<h3>${i+1}. ${escapeHtml(s.name)}</h3><div class="meta">${escapeHtml(s.source)} · ${s.distanceMiles.toFixed(1)} mi · <span class="score">Score ${s.score}</span></div><p class="addr">${escapeHtml(s.address)}</p>${statusHtml(s.status)}${s.capacity ? `<p class="capacity"><strong>Capacity:</strong> ${escapeHtml(s.capacity)}</p>` : ''}<p>${pointInAnyAlert(s.lat, s.lng) ? '<span class="badTag">Inside active alert polygon</span>' : '<span class="goodTag">Outside mapped alert polygons</span>'}</p><div class="actions"><a target="_blank" href="${directionsUrl(s)}">Directions</a><button type="button" class="routeItem">Route</button></div>`;
    article.querySelector('.routeItem').addEventListener('click', () => routeTo(s));
    results.appendChild(article);
  });
  if (group.getBounds().isValid()) map.fitBounds(group.getBounds().pad(0.25));
}

function popupHtml(s) {
  const info = getStatusDescription(s.status);
  return `<strong>${escapeHtml(s.name)}</strong><br>${escapeHtml(s.address)}<br>${s.distanceMiles.toFixed(1)} miles · Score ${s.score}<br>Status: ${escapeHtml(info.short)}${info.code && info.code.toUpperCase() !== info.short.toUpperCase() ? ' (' + escapeHtml(info.code) + ')' : ''}<br><small>${escapeHtml(info.long)}</small><br><a target="_blank" href="${directionsUrl(s)}">Open directions</a>`;
}

async function loadAlerts(lat, lng) {
  $('alertsText').textContent = 'Loading active NWS alerts and polygon geometry…';
  activeAlerts = [];
  clearAlerts();
  try {
    const json = await fetchJson(`${NWS_ALERTS}?point=${lat},${lng}`, { headers: { Accept: 'application/geo+json, application/json' } });
    const features = json.features || [];
    activeAlerts = await Promise.all(features.map(hydrateAlertGeometry));
    const withGeometry = activeAlerts.filter(f => f.geometry).length;
    localStorage.setItem('lastAlerts', JSON.stringify({ ts: Date.now(), items: activeAlerts }));
    renderAlerts();
    if (!activeAlerts.length) {
      $('alertsText').textContent = 'No active NWS alerts for this point.';
    } else {
      $('alertsText').textContent = `${activeAlerts.length} active alert(s) for this point. ${withGeometry} have drawable polygon/zone geometry.`;
    }
    renderShelters(applyFilters(allShelters));
  } catch (err) {
    console.error(err);
    $('alertsText').textContent = 'NWS alert load failed: ' + err.message;
  }
}

async function hydrateAlertGeometry(feature) {
  if (feature.geometry) return feature;
  const zones = feature.properties?.affectedZones || [];
  if (!zones.length) return feature;

  // Many NWS alerts are zone/county-based and arrive with geometry:null.
  // The affectedZones URLs expose GeoJSON geometries, so fetch those and combine them.
  const geometries = [];
  const limitedZones = zones.slice(0, NWS_MAX_ZONE_GEOMETRIES);
  const zoneResults = await Promise.allSettled(limitedZones.map(url => fetchJson(url, { headers: { Accept: 'application/geo+json, application/json' } })));
  zoneResults.forEach(r => {
    if (r.status !== 'fulfilled') return;
    const z = r.value;
    if (z.geometry) geometries.push(z.geometry);
    else if (z.type === 'Feature' && z.geometry) geometries.push(z.geometry);
  });
  if (geometries.length === 1) feature.geometry = geometries[0];
  else if (geometries.length > 1) feature.geometry = { type: 'GeometryCollection', geometries };
  feature.properties = { ...(feature.properties || {}), zoneGeometryCount: geometries.length, zoneGeometryLimited: zones.length > limitedZones.length };
  return feature;
}

function renderAlerts() {
  clearAlerts();
  const list = $('alertsList');
  list.innerHTML = '';
  activeAlerts.forEach(f => {
    const p = f.properties || {};
    const item = document.createElement('div');
    item.className = 'alertItem';
    const geomNote = f.geometry ? 'polygon/zone mapped' : 'no polygon from NWS';
    item.innerHTML = `<strong>${escapeHtml(p.event || 'NWS Alert')}</strong><br><small>${escapeHtml(p.severity || '')} · ${escapeHtml(p.areaDesc || '')} · ${geomNote}</small>`;
    list.appendChild(item);
    if ($('layerAlerts').checked && f.geometry) {
      const layer = L.geoJSON(f.geometry, {
        style: alertStyle(p),
        onEachFeature: (_feature, lyr) => lyr.bindPopup(`<strong>${escapeHtml(p.event || 'NWS Alert')}</strong><br>${escapeHtml(p.areaDesc || '')}<br>${escapeHtml(p.headline || '')}`)
      }).addTo(map);
      alertLayers.push(layer);
    }
  });
}

function pointInAnyAlert(lat, lng) { return activeAlerts.some(f => f.geometry && pointInGeometry([lng, lat], f.geometry)); }
function pointInGeometry(pt, g) {
  if (!g) return false;
  if (g.type === 'Polygon') return g.coordinates.some(poly => inRing(pt, poly[0]));
  if (g.type === 'MultiPolygon') return g.coordinates.some(polys => polys.some(poly => inRing(pt, poly[0])));
  if (g.type === 'GeometryCollection') return (g.geometries || []).some(child => pointInGeometry(pt, child));
  return false;
}

function alertStyle(p = {}) {
  const event = String(p.event || '').toLowerCase();
  const severity = String(p.severity || '').toLowerCase();
  let color = '#ef4444';
  if (event.includes('tornado')) color = '#dc2626';
  else if (event.includes('thunderstorm')) color = '#f97316';
  else if (event.includes('flood')) color = '#2563eb';
  else if (event.includes('winter')) color = '#38bdf8';
  else if (severity === 'minor') color = '#f59e0b';
  return { color, weight: 3, opacity: 0.95, fillColor: color, fillOpacity: 0.16 };
}
function inRing(pt, ring) {
  let inside = false, x = pt[0], y = pt[1];
  for (let i=0, j=ring.length-1; i<ring.length; j=i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

async function routeToBest() {
  const items = applyFilters(allShelters);
  if (!currentCenter) return setStatus('Choose a location first.');
  if (!items.length) return setStatus('No shelters available to route to.');
  routeTo(items[0]);
}
async function routeTo(s) {
  if (!currentCenter) return setStatus('Choose a location first.');
  setStatus(`Routing to ${s.name}…`);
  try {
    const json = await fetchJson(`${OSRM}/${currentCenter.lng},${currentCenter.lat};${s.lng},${s.lat}?overview=full&geometries=geojson`);
    const route = json.routes && json.routes[0];
    if (!route) throw new Error('No route found');
    if (routeLayer) routeLayer.remove();
    routeLayer = L.geoJSON(route.geometry, { style: { color: '#fbbf24', weight: 5 } }).addTo(map);
    map.fitBounds(routeLayer.getBounds().pad(0.2));
    setStatus(`Route: ${(route.distance / 1609.344).toFixed(1)} miles, about ${Math.round(route.duration / 60)} minutes.`);
  } catch (err) {
    setStatus('Routing failed: ' + err.message + '. Use the Directions link as a backup.');
  }
}
function directionsUrl(s) {
  if (currentCenter) return `https://www.google.com/maps/dir/?api=1&origin=${currentCenter.lat},${currentCenter.lng}&destination=${s.lat},${s.lng}`;
  return `https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lng}`;
}

function switchBaseMap() {
  Object.values(baseLayers).forEach(layer => { if (map.hasLayer(layer)) map.removeLayer(layer); });
  const layer = baseLayers[$('baseMap').value] || baseLayers.street;
  layer.addTo(map);
  if ($('layerRadar').checked) applyRadarMode();
  if ($('layerLightning').checked && !map.hasLayer(lightningLayer)) lightningLayer.addTo(map);
  setStatus(`Base map changed to ${$('baseMap').value}.`);
}


// Dynamic NOAA/NWS MRMS radar tile layer. It requests crisp ArcGIS export-map images per Leaflet tile,
// avoiding the blurry low-zoom national mosaic problem when zoomed into a town.
L.NoaaRadarLayer = L.TileLayer.extend({
  initialize: function(url, options) {
    this._url = url;
    L.setOptions(this, Object.assign({ tileSize: 256, opacity: 0.65, zIndex: 355, maxZoom: 19 }, options || {}));
  },
  getTileUrl: function(coords) {
    const tileSize = this.options.tileSize;
    const nw = coords.scaleBy ? coords : coords;
    const bounds = this._tileCoordsToBounds(nw);
    const sw = L.CRS.EPSG3857.project(bounds.getSouthWest());
    const ne = L.CRS.EPSG3857.project(bounds.getNorthEast());
    const bbox = [sw.x, sw.y, ne.x, ne.y].join(',');
    const params = new URLSearchParams({
      f: 'image', transparent: 'true', format: 'png32', layers: 'show:3',
      bbox, bboxSR: '102100', imageSR: '102100', size: `${tileSize},${tileSize}`
    });
    return `${this._url}?${params.toString()}`;
  }
});
L.noaaRadarLayer = function(url, options) { return new L.NoaaRadarLayer(url, options); };

async function initRadarAnimation() {
  try {
    $('radarTime').textContent = 'Loading animated radar timeline…';
    const data = await fetchJson(RAINVIEWER_API);
    const host = data.host || RAINVIEWER_TILE;
    const frames = [...(data.radar?.past || []), ...(data.radar?.nowcast || [])].slice(-12);
    radarFrames = frames.map(frame => ({
      time: frame.time,
      path: `${host}${frame.path}/256/{z}/{x}/{y}/3/1_1.png`,
      layer: L.tileLayer(`${host}${frame.path}/512/{z}/{x}/{y}/4/1_1.png`, { tileSize: 512, zoomOffset: -1, opacity: 0, zIndex: 360, maxZoom: 19, maxNativeZoom: 10, updateWhenZooming: false, keepBuffer: 4, attribution: 'Radar animation: RainViewer / source radar providers' })
    }));
    radarFrameIndex = Math.max(0, radarFrames.length - 1);
    if (!radarFrames.length) throw new Error('No radar frames returned');
    if ($('layerRadar').checked && getRadarMode() === 'animated') { showRadarFrame(radarFrameIndex, false); startRadarTimer(); }
    updateRadarLabel();
  } catch (err) {
    console.warn('Animated radar failed; using fallback tile', err);
    $('radarTime').textContent = 'Animated radar failed; using static NEXRAD fallback.';
    if ($('layerRadar').checked) { showNexradRadar(); }
  }
}

function getRadarMode() {
  const node = $('radarMode');
  return node ? node.value : 'animated';
}

function removeAnimatedRadarFrames() {
  radarFrames.forEach(f => { if (map.hasLayer(f.layer)) map.removeLayer(f.layer); });
}

function showNexradRadar() {
  stopRadarTimer();
  removeAnimatedRadarFrames();
  if (map.hasLayer(radarFallbackLayer)) map.removeLayer(radarFallbackLayer);
  if (!map.hasLayer(radarCurrentLayer)) radarCurrentLayer.addTo(map);
  $('radarTime').textContent = 'NEXRAD / NOAA current radar mode. Animation controls are disabled in this mode.';
  const controls = $('radarAnimationControls');
  if (controls) controls.classList.add('mutedControls');
  ['radarBackBtn','radarPlayBtn','radarForwardBtn'].forEach(id => { const b = $(id); if (b) b.disabled = true; });
}

function showAnimatedRadar() {
  if (!radarFrames.length) {
    if (!map.hasLayer(radarFallbackLayer)) radarFallbackLayer.addTo(map);
    if (map.hasLayer(radarCurrentLayer)) map.removeLayer(radarCurrentLayer);
    $('radarTime').textContent = 'Animated radar timeline unavailable; showing fallback NEXRAD tiles.';
    return;
  }
  if (map.hasLayer(radarFallbackLayer)) map.removeLayer(radarFallbackLayer);
  if (map.hasLayer(radarCurrentLayer)) map.removeLayer(radarCurrentLayer);
  const controls = $('radarAnimationControls');
  if (controls) controls.classList.remove('mutedControls');
  ['radarBackBtn','radarPlayBtn','radarForwardBtn'].forEach(id => { const b = $(id); if (b) b.disabled = false; });
  showRadarFrame(radarFrameIndex, false);
  if (radarPlaying) startRadarTimer();
}

function applyRadarMode() {
  if (!$('layerRadar').checked) return toggleRadar();
  if (getRadarMode() === 'nexrad') {
    showNexradRadar();
    setStatus('Radar mode: NEXRAD / NOAA current radar.');
  } else {
    showAnimatedRadar();
    setStatus('Radar mode: animated radar loop.');
  }
}

function showRadarFrame(index, smooth = true) {
  if (!$('layerRadar').checked || getRadarMode() !== 'animated') return;
  if (!radarFrames.length) { if (!map.hasLayer(radarFallbackLayer)) radarFallbackLayer.addTo(map); return; }
  if (map.hasLayer(radarCurrentLayer)) map.removeLayer(radarCurrentLayer);
  if (map.hasLayer(radarFallbackLayer)) map.removeLayer(radarFallbackLayer);
  radarFrameIndex = (index + radarFrames.length) % radarFrames.length;
  radarFrames.forEach((frame, i) => {
    if (!map.hasLayer(frame.layer)) frame.layer.addTo(map);
    frame.layer.setOpacity(i === radarFrameIndex ? 0.55 : 0);
  });
  updateRadarLabel();
}

function updateRadarLabel() {
  if (!radarFrames.length) return;
  const frame = radarFrames[radarFrameIndex];
  const ts = new Date(frame.time * 1000).toLocaleString([], { timeStyle: 'short', dateStyle: 'short' });
  $('radarTime').textContent = `Animated radar frame ${radarFrameIndex + 1}/${radarFrames.length}: ${ts}`;
}

function startRadarTimer() {
  stopRadarTimer();
  radarTimer = setInterval(() => { if (radarPlaying && $('layerRadar').checked && getRadarMode() === 'animated') showRadarFrame(radarFrameIndex + 1); }, 900);
}
function stopRadarTimer() { if (radarTimer) clearInterval(radarTimer); radarTimer = null; }
function stepRadar(delta) { radarPlaying = false; $('radarPlayBtn').textContent = '▶ Play'; showRadarFrame(radarFrameIndex + delta); }
function toggleRadarPlayback() { radarPlaying = !radarPlaying; $('radarPlayBtn').textContent = radarPlaying ? '⏸ Pause' : '▶ Play'; if (radarPlaying && getRadarMode() === 'animated') startRadarTimer(); else stopRadarTimer(); }
function toggleRadar() {
  if ($('layerRadar').checked) {
    applyRadarMode();
  } else {
    stopRadarTimer();
    removeAnimatedRadarFrames();
    if (map.hasLayer(radarFallbackLayer)) map.removeLayer(radarFallbackLayer);
    if (map.hasLayer(radarCurrentLayer)) map.removeLayer(radarCurrentLayer);
    setStatus('Radar overlay disabled.');
  }
}

function toggleLightning() {
  if ($('layerLightning').checked) {
    lightningLayer.addTo(map);
    refreshLightningFeed();
    setStatus('Lightning layer enabled. It will display WebSocket-pushed strikes or your configured GeoJSON feed.');
  } else {
    if (map.hasLayer(lightningLayer)) map.removeLayer(lightningLayer);
    setStatus('Lightning layer disabled.');
  }
}
async function refreshLightningFeed() {
  let feed = $('lightningFeed').value.trim();
  if (!feed && location.protocol.startsWith('http')) feed = '/api/lightning/wwlln';
  if (!feed) { renderLightning(); return; }
  try {
    const geo = await fetchJson(feed);
    const strikes = [];
    if (Array.isArray(geo.strikes)) {
      geo.strikes.forEach(s => strikes.push({ lat: Number(s.lat), lng: Number(s.lng ?? s.lon), time: s.time || s.timestamp || new Date().toISOString(), source: s.source || geo.source || 'Lightning feed' }));
    } else if (geo.type === 'FeatureCollection') {
      geo.features.forEach(f => {
        const c = f.geometry?.coordinates;
        if (f.geometry?.type === 'Point' && c) strikes.push({ lng: Number(c[0]), lat: Number(c[1]), time: f.properties?.time || f.properties?.timestamp || new Date().toISOString(), source: f.properties?.source || 'GeoJSON' });
      });
    }
    lightningStrikes = strikes;
    renderLightning();
  } catch (err) {
    console.warn('Lightning feed failed', err);
    setStatus('Lightning feed failed: ' + err.message + '. WebSocket/local feed will still display if available.');
  }
}
function renderLightning() {
  lightningLayer.clearLayers();
  const recent = lightningStrikes.slice(-400);
  recent.forEach(s => {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng)) return;
    const marker = L.circleMarker([s.lat, s.lng], { radius: 6, color: '#fde047', fillColor: '#facc15', fillOpacity: 0.85, weight: 2, className: 'lightningPulse' })
      .bindPopup(`<strong>Lightning detection</strong><br>${escapeHtml(s.time || '')}<br>${escapeHtml(s.source || '')}`);
    lightningLayer.addLayer(marker);
  });
  $('liveStatus').textContent = `Live updates: ${liveSocket && liveSocket.readyState === WebSocket.OPEN ? 'WebSocket connected' : 'browser fallback'} · Lightning strikes shown: ${recent.length}`;
}

function connectLiveSocket() {
  disconnectLiveSocket(false);
  const explicit = $('wsUrl').value.trim();
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = explicit || `${proto}//${location.host}/ws`;
  try {
    liveSocket = new WebSocket(url);
    liveSocket.onopen = () => { $('liveStatus').textContent = `Live updates: WebSocket connected (${url})`; sendLiveSubscription(); };
    liveSocket.onclose = () => { $('liveStatus').textContent = 'Live updates: WebSocket disconnected; using 5-minute fallback refresh.'; };
    liveSocket.onerror = () => { $('liveStatus').textContent = 'Live updates: WebSocket error; using fallback refresh.'; };
    liveSocket.onmessage = ev => handleLiveMessage(ev.data);
  } catch (err) {
    $('liveStatus').textContent = 'Live updates: connect failed: ' + err.message;
  }
}
function disconnectLiveSocket(update = true) {
  if (liveSocket) { try { liveSocket.close(); } catch {} }
  liveSocket = null;
  if (update) $('liveStatus').textContent = 'Live updates: disconnected; browser fallback mode.';
}
function sendLiveSubscription() {
  if (!liveSocket || liveSocket.readyState !== WebSocket.OPEN || !currentCenter) return;
  liveSocket.send(JSON.stringify({ type: 'subscribe', center: currentCenter, radiusMiles: Number($('radiusMiles').value || 25) }));
}
function handleLiveMessage(raw) {
  try {
    const msg = JSON.parse(raw);
    if (msg.type === 'hello') $('liveStatus').textContent = `Live updates: connected. ${msg.message || ''}`;
    if (msg.type === 'alerts') {
      activeAlerts = msg.features || [];
      renderAlerts();
      $('alertsText').textContent = `${activeAlerts.length} active alert(s) pushed by WebSocket.`;
      renderShelters(applyFilters(allShelters));
    }
    if (msg.type === 'lightning') {
      lightningStrikes = [...lightningStrikes, ...(msg.strikes || [])].slice(-1000);
      if ($('layerLightning').checked) renderLightning();
    }
    if (msg.type === 'refreshShelters' && currentCenter) loadShelters(currentCenter.lat, currentCenter.lng);
  } catch (err) { console.warn('Bad live message', err, raw); }
}

function toggleClosures() {
  if ($('layerTraffic').checked) {
    closuresLayer.addTo(map);
    setStatus('Road-closure layer enabled as a placeholder. Add your state/county DOT GeoJSON feed in app.js.');
  } else {
    map.removeLayer(closuresLayer);
    setStatus('Road-closure placeholder disabled.');
  }
}
function clearShelterMarkers() { markers.forEach(m => m.remove()); markers = []; if (routeLayer) { routeLayer.remove(); routeLayer = null; } $('results').innerHTML = ''; }
function clearAlerts() { alertLayers.forEach(l => l.remove()); alertLayers = []; }

function addCheckin() {
  const name = $('checkName').value.trim();
  if (!name) return setStatus('Enter a name for check-in.');
  const data = JSON.parse(localStorage.getItem('checkins') || '[]').filter(x => x.name.toLowerCase() !== name.toLowerCase());
  data.unshift({ name, status: $('checkStatus').value, time: new Date().toISOString(), center: currentCenter });
  localStorage.setItem('checkins', JSON.stringify(data));
  $('checkName').value = '';
  renderCheckins();
}
function renderCheckins() {
  const data = JSON.parse(localStorage.getItem('checkins') || '[]');
  $('checkList').innerHTML = data.length ? data.map((x, idx) => `
    <div class="checkItem">
      <div class="checkText"><strong>${escapeHtml(x.name)}</strong> — ${escapeHtml(x.status)}<br><small>${new Date(x.time).toLocaleString()}</small></div>
      <button type="button" class="deleteCheckBtn" data-check-index="${idx}" title="Delete check-in for ${escapeHtml(x.name)}">Delete</button>
    </div>`).join('') : '<small>No check-ins yet.</small>';
}
function bindCheckinDeleteHandler() {
  const list = $('checkList');
  if (!list || list.dataset.deleteBound === '1') return;
  list.dataset.deleteBound = '1';
  list.addEventListener('click', ev => {
    const btn = ev.target.closest('.deleteCheckBtn');
    if (!btn) return;
    ev.preventDefault();
    deleteCheckin(Number(btn.dataset.checkIndex));
  });
}
function deleteCheckin(index) {
  const data = JSON.parse(localStorage.getItem('checkins') || '[]');
  if (!Number.isInteger(index) || index < 0 || index >= data.length) return;
  const removed = data.splice(index, 1)[0];
  localStorage.setItem('checkins', JSON.stringify(data));
  renderCheckins();
  setStatus(`Deleted check-in: ${removed?.name || 'entry'}`);
}
function situation() {
  return {
    generated: new Date().toISOString(), center: currentCenter,
    alerts: activeAlerts.map(f => ({ event: f.properties?.event, severity: f.properties?.severity, area: f.properties?.areaDesc })),
    topShelters: applyFilters(allShelters).slice(0, 5).map(s => ({ name: s.name, address: s.address, lat: s.lat, lng: s.lng, distanceMiles: s.distanceMiles, score: s.score, status: s.status, source: s.source })),
    checkins: JSON.parse(localStorage.getItem('checkins') || '[]')
  };
}
async function sendSituation() {
  const url = $('webhookUrl').value.trim();
  if (!url) return setStatus('Enter a webhook, ntfy, or local relay URL first.');
  try {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(situation()) });
    setStatus('Situation summary sent.');
  } catch (err) {
    setStatus('Send failed: ' + err.message + '. Browser CORS may block this endpoint.');
  }
}
function exportJson() {
  const blob = new Blob([JSON.stringify(situation(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'storm-shelter-situation.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

function dedupe(items) {
  const seen = new Set(), out = [];
  for (const s of items) {
    const key = `${s.name}|${Math.round(s.lat*10000)}|${Math.round(s.lng*10000)}`.toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(s); }
  }
  return out;
}
function haversine(lat1, lon1, lat2, lon2) {
  const R = 3958.8, rad = v => v * Math.PI / 180;
  const dLat = rad(lat2-lat1), dLon = rad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
async function fetchJson(url, options = {}) {
  const headers = { Accept: 'application/json, application/geo+json, */*', ...(options.headers || {}) };
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[ch]));
}
