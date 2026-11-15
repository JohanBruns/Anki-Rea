// Local server: serves the web app and the API. Uses SQLite in data/ – or Postgres when DATABASE_URL is set.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi, lanAddresses, sendJson } from './api.js';
import { openDatabase } from './db.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const PORT = Number(process.env.PORT || 8420);
const HOST = process.env.HOST || '0.0.0.0';
const target = process.env.DATABASE_URL || process.env.ANKI_REA_DB || path.join(root, 'data', 'anki-rea.db');

const db = await openDatabase(target);
const api = createApi(db, { port: PORT });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.resolve(publicDir, `.${rel}`);
  if (!file.startsWith(publicDir + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Nicht gefunden');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) await api(req, res, url);
  else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(url.pathname, res);
  else sendJson(res, 405, { error: 'Methode nicht erlaubt' });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} ist schon belegt. Läuft Anki Rea bereits?`);
  else console.error(err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('\n  Anki Rea läuft.\n');
  console.log(`  Am PC:      http://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(`  Am Handy:   http://${ip}:${PORT}   (gleiches WLAN)`);
  console.log(`\n  Daten:      ${db.dialect === 'postgres' ? 'Postgres (DATABASE_URL)' : target}`);
  if (process.env.ANKI_REA_PASSWORD) console.log('  Passwort:   aktiv');
  console.log('  Beenden:    Strg+C\n');
});

const shutdown = async () => {
  server.close();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
