'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const AdmZip = require('adm-zip');

const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname;
const NWS_ALERTS = 'https://api.weather.gov/alerts/active';
const WWLLN_KMZ = process.env.WWLLN_KMZ_URL || 'https://wwlln.net/WWLLN.kmz';
let lightningCache = { at: 0, data: null };

const clients = new Map();

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/api/lightning/wwlln')) {
    getWwllnLightning().then(data => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(data));
    }).catch(err => {
      res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: false, error: err.message, source: 'WWLLN' }));
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/lightning') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        const strikes = Array.isArray(parsed) ? parsed : (parsed.strikes || [parsed]);
        broadcast({ type: 'lightning', strikes });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, count: strikes.length }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  file = path.normalize(file).replace(/^\.\.(\/|\\|$)/, '');
  const fp = path.join(ROOT, file);
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': typeFor(fp), 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', ws => {
  clients.set(ws, { center: null, radiusMiles: 25, lastAlertKey: '' });
  ws.send(JSON.stringify({ type: 'hello', message: 'Server-push live updates are active.' }));
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'subscribe') {
        const state = clients.get(ws) || {};
        state.center = msg.center;
        state.radiusMiles = Number(msg.radiusMiles || 25);
        clients.set(ws, state);
        pushAlerts(ws).catch(err => ws.send(JSON.stringify({ type: 'error', message: err.message })));
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: 'Bad subscription message: ' + err.message }));
    }
  });
  ws.on('close', () => clients.delete(ws));
});

setInterval(() => {
  for (const ws of clients.keys()) {
    if (ws.readyState === ws.OPEN) pushAlerts(ws).catch(() => {});
  }
}, Number(process.env.ALERT_PUSH_INTERVAL_MS || 120000));

async function pushAlerts(ws) {
  const state = clients.get(ws);
  if (!state || !state.center) return;
  const { lat, lng } = state.center;
  const resp = await fetch(`${NWS_ALERTS}?point=${lat},${lng}`, { headers: { 'Accept': 'application/geo+json, application/json', 'User-Agent': 'storm-shelter-dashboard/1.0' } });
  if (!resp.ok) throw new Error(`NWS ${resp.status}`);
  const json = await resp.json();
  const features = json.features || [];
  const key = features.map(f => `${f.id}|${f.properties?.updated || f.properties?.sent}`).join('\n');
  if (key === state.lastAlertKey) return;
  state.lastAlertKey = key;
  ws.send(JSON.stringify({ type: 'alerts', features, pushedAt: new Date().toISOString() }));
}


async function getWwllnLightning() {
  const now = Date.now();
  if (lightningCache.data && now - lightningCache.at < 5 * 60 * 1000) return lightningCache.data;
  const resp = await fetch(WWLLN_KMZ, { headers: { 'User-Agent': 'storm-shelter-dashboard/2.1' } });
  if (!resp.ok) throw new Error(`WWLLN ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const zip = new AdmZip(buf);
  const entry = zip.getEntries().find(e => e.entryName.toLowerCase().endsWith('.kml'));
  if (!entry) throw new Error('No KML found inside WWLLN KMZ');
  const kml = entry.getData().toString('utf8');
  const strikes = [];
  const placemarks = kml.match(/<Placemark[\s\S]*?<\/Placemark>/gi) || [];
  for (const pm of placemarks) {
    const coord = (pm.match(/<coordinates>\s*([^<]+)\s*<\/coordinates>/i) || [])[1];
    if (!coord) continue;
    const [lon, lat] = coord.trim().split(/[ ,]+/).map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const name = stripXml((pm.match(/<name>\s*([\s\S]*?)\s*<\/name>/i) || [,''])[1]);
    const desc = stripXml((pm.match(/<description>\s*([\s\S]*?)\s*<\/description>/i) || [,''])[1]);
    strikes.push({ lat, lng: lon, time: name || desc || new Date().toISOString(), source: 'WWLLN delayed public KMZ' });
  }
  const data = { ok: true, source: 'WWLLN public delayed KMZ', generatedAt: new Date().toISOString(), count: strikes.length, strikes };
  lightningCache = { at: now, data };
  return data;
}
function stripXml(v) { return String(v || '').replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim(); }

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of clients.keys()) if (ws.readyState === ws.OPEN) ws.send(msg);
}
function typeFor(fp) {
  if (fp.endsWith('.html')) return 'text/html; charset=utf-8';
  if (fp.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (fp.endsWith('.css')) return 'text/css; charset=utf-8';
  if (fp.endsWith('.json') || fp.endsWith('.webmanifest')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

server.listen(PORT, () => console.log(`Storm Shelter Dashboard listening on http://0.0.0.0:${PORT}`));
