import os from 'node:os';
import { createAuth } from './auth.js';
import { HttpError } from './db.js';
import { commitImport, exportJson, exportText, parseOrFail, previewImport } from './importService.js';
import {
  createDeck,
  createNote,
  deckDetails,
  deleteDeck,
  deleteNote,
  getNote,
  listDecks,
  listNotes,
  resetNote,
  updateDeck,
  updateNote,
} from './notes.js';
import { getStats } from './stats.js';
import { answer, extendNewCards, nextCard, setSuspended, undo } from './study.js';

const MAX_JSON = 2 * 1024 * 1024;
// Vercel limits request bodies to 4.5 MB; locally larger Anki packages are fine.
const MAX_UPLOAD = process.env.VERCEL ? 4.4 * 1024 * 1024 : 200 * 1024 * 1024;

export function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
    }
  }
  return out.sort((a, b) => Number(b.startsWith('192.168.')) - Number(a.startsWith('192.168.')));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, `Die Datei ist zu groß (max. ${Math.floor(limit / 1024 / 1024)} MB).`));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, MAX_JSON);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Ungültige Anfrage.');
  }
}

export function sendJson(res, status, data, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}

function sendDownload(res, filename, type, body) {
  res.writeHead(200, {
    'content-type': type,
    'content-disposition': `attachment; filename="${filename.replace(/[^\w.-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'cache-control': 'no-store',
  });
  res.end(body);
}

const filenameOf = (req) => {
  try {
    return decodeURIComponent(String(req.headers['x-filename'] || 'liste.txt'));
  } catch {
    return 'liste.txt';
  }
};

/** Returns an async (req, res, url) handler for every /api/* request, including error handling. */
export function createApi(db, { port, auth = createAuth() } = {}) {
  const routes = [];
  const route = (method, pattern, handler, { open = false } = {}) =>
    routes.push({ method, open, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler });

  // --- session ---
  route('GET', '/api/session', ({ req }) => ({ authRequired: auth.enabled, authenticated: auth.isAuthenticated(req) }), { open: true });
  route(
    'POST',
    '/api/login',
    async ({ req, res }) => {
      const { password } = await readJson(req);
      if (!auth.enabled) return { ok: true };
      if (!auth.checkPassword(password)) {
        await new Promise((r) => setTimeout(r, 800)); // slow down guessing
        throw new HttpError(401, 'Falsches Passwort.');
      }
      sendJson(res, 200, { ok: true }, { 'set-cookie': auth.loginCookie(req) });
      return undefined;
    },
    { open: true },
  );
  route(
    'POST',
    '/api/logout',
    ({ req, res }) => {
      sendJson(res, 200, { ok: true }, { 'set-cookie': auth.logoutCookie(req) });
      return undefined;
    },
    { open: true },
  );

  route('GET', '/api/info', () => ({
    name: 'Anki Rea',
    hosted: !!process.env.VERCEL,
    urls: process.env.VERCEL ? [] : lanAddresses().map((ip) => `http://${ip}:${port}`),
  }));

  // --- decks & studying ---
  route('GET', '/api/decks', () => listDecks(db));
  route('POST', '/api/decks', async ({ req }) => ({ id: await createDeck(db, (await readJson(req)).name) }));
  route('GET', '/api/decks/:id', ({ p }) => deckDetails(db, p.id));
  route('PATCH', '/api/decks/:id', async ({ req, p }) => updateDeck(db, p.id, await readJson(req)));
  route('DELETE', '/api/decks/:id', async ({ p }) => (await deleteDeck(db, p.id), { ok: true }));
  route('GET', '/api/decks/:id/next', ({ p, url }) =>
    nextCard(db, p.id, {
      exclude: Number(url.searchParams.get('exclude')) || 0,
      cardId: Number(url.searchParams.get('card')) || 0,
      ahead: url.searchParams.get('ahead') === '1',
    }),
  );
  route('POST', '/api/decks/:id/undo', ({ p, url }) => undo(db, p.id, { ahead: url.searchParams.get('ahead') === '1' }));
  route('POST', '/api/decks/:id/extend', async ({ req, p }) => extendNewCards(db, p.id, (await readJson(req)).newCards));

  route('POST', '/api/cards/:id/answer', async ({ req, p }) => {
    const body = await readJson(req);
    return answer(db, p.id, Number(body.rating), body.timeMs, Date.now(), { ahead: body.ahead === true });
  });
  route('POST', '/api/cards/:id/suspend', async ({ req, p }) => {
    const body = await readJson(req);
    return setSuspended(db, p.id, body.suspended !== false, { ahead: body.ahead === true });
  });

  // --- notes ---
  route('GET', '/api/notes', ({ url }) => listNotes(db, Object.fromEntries(url.searchParams)));
  route('POST', '/api/notes', async ({ req }) => createNote(db, await readJson(req)));
  route('GET', '/api/notes/:id', ({ p }) => getNote(db, p.id));
  route('PATCH', '/api/notes/:id', async ({ req, p }) => updateNote(db, p.id, await readJson(req)));
  route('DELETE', '/api/notes/:id', async ({ p }) => (await deleteNote(db, p.id), { ok: true }));
  route('POST', '/api/notes/:id/reset', ({ p }) => resetNote(db, p.id));

  // --- import / export ---
  route('POST', '/api/import/preview', async ({ req }) => previewImport(await readBody(req, MAX_UPLOAD), filenameOf(req)));
  // The client sends the file again with the commit, because on serverless hosting the preview
  // may have been created by a different instance.
  route('POST', '/api/import/commit', async ({ req, url }) => {
    const q = url.searchParams;
    const body = await readBody(req, MAX_UPLOAD);
    const opts = {
      token: q.get('token') || '',
      deckId: Number(q.get('deckId')) || null,
      deckName: q.get('deckName') || null,
      progress: q.get('progress') === '1',
    };
    return commitImport(db, opts, body.length ? parseOrFail(body, filenameOf(req)) : null);
  });

  route('GET', '/api/export', async ({ url, res }) => {
    const deckId = Number(url.searchParams.get('deck')) || null;
    const stamp = new Date().toISOString().slice(0, 10);
    if (url.searchParams.get('format') === 'text') {
      sendDownload(res, `anki-rea-${stamp}.txt`, 'text/plain; charset=utf-8', await exportText(db, deckId));
    } else {
      sendDownload(res, `anki-rea-backup-${stamp}.json`, 'application/json; charset=utf-8', JSON.stringify(await exportJson(db, deckId), null, 1));
    }
    return undefined;
  });

  route('GET', '/api/stats', ({ url }) => getStats(db, Number(url.searchParams.get('deck')) || null));

  return async function handle(req, res, url) {
    try {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        if (!r.open && !auth.isAuthenticated(req)) throw Object.assign(new HttpError(401, 'Bitte anmelden.'), { login: true });
        const p = Object.fromEntries(Object.entries(m.groups || {}).map(([k, v]) => [k, decodeURIComponent(v)]));
        const result = await r.handler({ req, res, url, p });
        if (result !== undefined) sendJson(res, 200, result);
        return;
      }
      throw new HttpError(404, 'Unbekannte Anfrage');
    } catch (err) {
      if (!err.status) console.error(err);
      if (!res.headersSent) {
        sendJson(res, err.status || 500, {
          error: err.expose ? err.message : 'Interner Fehler – Details im Server-Log.',
          ...(err.login ? { login: true } : {}),
        });
      }
    }
  };
}
