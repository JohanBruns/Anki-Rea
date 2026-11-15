import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { createApi } from '../server/api.js';
import { createAuth } from '../server/auth.js';
import { openDatabase } from '../server/db.js';

let server;
let base;
let db;

before(async () => {
  db = await openDatabase(process.env.TEST_DATABASE_URL || ':memory:');
  const handle = createApi(db, { port: 0, auth: createAuth({ password: 'geheim', secret: 'test' }) });
  server = http.createServer((req, res) => handle(req, res, new URL(req.url, 'http://localhost')));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await db.close();
});

const call = (path, opts = {}) => fetch(base + path, opts);

test('API is locked without the session cookie', async () => {
  const res = await call('/api/decks');
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'Bitte anmelden.', login: true });
  const session = await (await call('/api/session')).json();
  assert.deepEqual(session, { authRequired: true, authenticated: false });
});

test('wrong password is rejected, right password unlocks the API', async () => {
  const wrong = await call('/api/login', { method: 'POST', body: JSON.stringify({ password: 'falsch' }) });
  assert.equal(wrong.status, 401);

  const ok = await call('/api/login', { method: 'POST', body: JSON.stringify({ password: 'geheim' }) });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.match(ok.headers.get('set-cookie'), /HttpOnly/);

  const headers = { cookie };
  const created = await call('/api/decks', { method: 'POST', headers, body: JSON.stringify({ name: 'Spanisch' }) });
  assert.equal(created.status, 200);

  // Import: preview, then commit with the file sent again (works across serverless instances).
  const file = 'betteln - mendigar\nverkaufen - vender\n';
  const fileHeaders = { ...headers, 'x-filename': 'Spanisch.txt' };
  const preview = await (await call('/api/import/preview', { method: 'POST', headers: fileHeaders, body: file })).json();
  assert.equal(preview.total, 2);
  const commit = await call(`/api/import/commit?token=unknown-token&progress=0`, { method: 'POST', headers: fileHeaders, body: file });
  const result = await commit.json();
  assert.equal(result.added, 2);
  assert.equal(result.decks[0].name, 'Spanisch', 'merged into the existing deck with the same name');

  const decks = await (await call('/api/decks', { headers })).json();
  assert.equal(decks.find((d) => d.name === 'Spanisch').counts.new, 2);
});
