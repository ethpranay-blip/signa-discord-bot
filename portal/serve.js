// Signa Terminal — hosted live server.
// Serves portal/terminal.html and proxies whitelisted Signa endpoints
// SERVER-SIDE (no CORS, key never reaches the browser).
//
// Runs two ways:
//   1. Standalone (local):        node portal/serve.js         → http://localhost:8899
//   2. Embedded (Railway):        startPortal() called from bot.js — binds
//      0.0.0.0:$PORT so Railway's "Generate Domain" exposes it publicly.
//
// Protection (both required for public hosting):
//   PORTAL_TOKEN   access code — viewers enter it once (?token= / x-portal-token).
//                  If unset, the portal is OPEN (fine locally, not for public).
//   Rate cap       proxied Signa calls limited to PORTAL_HOURLY_CAP per hour
//                  (default 30) so dashboard viewers can't starve the bot's
//                  60/hr Signa budget. Over cap → 429.
//
// No dependencies beyond dotenv (already installed).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(__dirname, 'terminal.html');
const SIGNA = 'https://app.getsigna.ai';

const calls = []; // timestamps of proxied Signa calls (sliding hour)
function overCap(cap) {
  const cut = Date.now() - 3_600_000;
  while (calls.length && calls[0] < cut) calls.shift();
  return calls.length >= cap;
}

function tokenOk(req, token) {
  if (!token) return true; // no token configured → open (local use)
  if (req.headers['x-portal-token'] === token) return true;
  try {
    const u = new URL(req.url, 'http://x');
    if (u.searchParams.get('token') === token) return true;
  } catch {}
  return false;
}

export function startPortal({ log = console.log, trackLogPath } = {}) {
  const TRACK_LOG = trackLogPath || process.env.TRACK_LOG_PATH || './signa_track.jsonl';
  const KEY = process.env.SIGNA_API_KEY;
  const TOKEN = process.env.PORTAL_TOKEN || '';
  const CAP = parseInt(process.env.PORTAL_HOURLY_CAP || '30', 10);
  const PORT = process.env.PORT || process.env.PORTAL_PORT || 8899;

  if (!KEY) { log('⚠️  portal: SIGNA_API_KEY missing — portal not started'); return null; }
  if (!fs.existsSync(HTML)) { log(`⚠️  portal: ${HTML} missing — portal not started`); return null; }
  // Fail-safe: an unauthenticated portal on a public host would expose the Signa
  // key's quota and the track log to anyone with the URL. Require a token unless
  // open mode is explicitly opted into (local dev).
  if (!TOKEN && (process.env.PORTAL_ALLOW_OPEN || '').toLowerCase() !== 'true') {
    log('⚠️  portal: PORTAL_TOKEN not set — portal NOT started (set PORTAL_TOKEN, or PORTAL_ALLOW_OPEN=true for local use)');
    return null;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const clean = req.url.split('?')[0];

      if (clean === '/' || clean === '/index.html') {
        if (!tokenOk(req, TOKEN)) {
          res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><body style="font-family:ui-monospace,monospace;background:#0B0F14;color:#E7EEF6;display:grid;place-items:center;min-height:95vh;margin:0"><form style="text-align:center"><div style="font-size:22px;margin-bottom:6px">📡 SIGNA TERMINAL</div><div style="color:#8493A3;font-size:13px;margin-bottom:18px">Enter access code</div><input name=token autofocus style="font:inherit;padding:10px 14px;border-radius:8px;border:1px solid #2F3D4C;background:#121A23;color:#E7EEF6;outline:none;text-align:center"><div style="margin-top:14px"><button style="font:inherit;padding:9px 22px;border-radius:8px;border:0;background:#E7AF4B;color:#111;cursor:pointer">Open</button></div></form></body>');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(HTML));
        return;
      }

      // Paper-validation track log. This process is the only one with access to
      // the volume, so the dashboard reads production calls/cycles from here.
      // Read-only, token-gated, returns parsed JSON (not raw JSONL) so the
      // browser can render it directly.
      if (clean === '/api/track-log') {
        if (!tokenOk(req, TOKEN)) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":"portal token required"}'); return; }
        let rows = [];
        let readErr = null;
        try {
          rows = fs.readFileSync(TRACK_LOG, 'utf8').split('\n').filter(Boolean).map((l) => {
            try { return JSON.parse(l); } catch { return null; }
          }).filter(Boolean);
        } catch (e) {
          readErr = e.code === 'ENOENT' ? 'log file not created yet (no cycles have run)' : e.message;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({
          ok: !readErr, path: TRACK_LOG, error: readErr,
          counts: {
            total: rows.length,
            calls: rows.filter((r) => r.type === 'call').length,
            cycles: rows.filter((r) => r.type === 'cycle').length,
          },
          rows,
        }));
        return;
      }

      if (/^\/api\/v1\/(signal|gex|analysis|quote|history|signal-index|scan|me)\b/.test(clean) || /^\/api\/darkpool\/prints\b/.test(clean)) {
        if (!tokenOk(req, TOKEN)) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":"portal token required"}'); return; }
        if (overCap(CAP)) { res.writeHead(429, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: `portal hourly cap reached (${CAP}/hr) — protects the bot's Signa budget` })); return; }
        calls.push(Date.now());
        // strip portal token before forwarding
        const u = new URL(req.url, 'http://x');
        u.searchParams.delete('token');
        const r = await fetch(SIGNA + u.pathname + (u.search || ''), {
          headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' },
        });
        const body = await r.text();
        res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(body);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e.message) }));
    }
  });

  server.on('error', (e) => log(`⚠️  portal server error: ${e.message}`));
  server.listen(PORT, '0.0.0.0', () => {
    log(`📡 Signa Terminal portal on :${PORT} · token ${TOKEN ? 'REQUIRED' : 'OFF (open)'} · proxy cap ${CAP}/hr`);
  });
  return server;
}

// Standalone: `node portal/serve.js`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!startPortal()) process.exit(1);
}
