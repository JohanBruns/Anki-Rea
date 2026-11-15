// Vercel serverless entry point. vercel.json rewrites every /api/* request to this function.
import { createApi } from '../server/api.js';
import { openDatabase } from '../server/db.js';

// Vercel runs in UTC; day boundaries (rollover at 4:00) and deadlines are meant in local time.
process.env.TZ = process.env.ANKI_REA_TZ || 'Europe/Berlin';

let ready;

function init() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new Error('DATABASE_URL fehlt – bitte in Vercel eine Neon-Datenbank mit dem Projekt verbinden.');
  if (!process.env.ANKI_REA_PASSWORD) throw new Error('ANKI_REA_PASSWORD fehlt – ohne Passwort wäre die App öffentlich.');
  return openDatabase(url).then((db) => createApi(db));
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'https://anki-rea.local');
  // After the rewrite the original path arrives as ?path=…; restore it.
  const rewritten = url.searchParams.get('path');
  if (rewritten !== null) {
    url.pathname = `/api/${rewritten}`;
    url.searchParams.delete('path');
  }
  try {
    ready ||= init();
    const handle = await ready;
    await handle(req, res, url);
  } catch (err) {
    ready = null;
    console.error(err);
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: err.message }));
  }
}
