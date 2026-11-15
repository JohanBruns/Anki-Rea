// Storage adapter: the same async API on top of SQLite (local) and Postgres (online, e.g. Neon on Vercel).
//   db.get(sql, ...args)  → first row or undefined
//   db.all(sql, ...args)  → rows
//   db.run(sql, ...args)  → { id, changes }   (id = inserted row id)
//   db.tx(async (t) => …) → runs the callback in a transaction; use `t` inside it
// SQL is written with `?` placeholders in the common subset of both dialects.
import fs from 'node:fs';
import path from 'node:path';

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS decks (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  config TEXT NOT NULL DEFAULT '{}',
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY,
  deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  front TEXT NOT NULL,
  back TEXT NOT NULL,
  extra TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  source_id TEXT,
  created INTEGER NOT NULL,
  modified INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_deck ON notes(deck_id);
CREATE INDEX IF NOT EXISTS idx_notes_source ON notes(source_id);
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY,
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'new',
  due INTEGER NOT NULL DEFAULT 0,
  ivl INTEGER NOT NULL DEFAULT 0,
  ease INTEGER NOT NULL DEFAULT 2500,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  step INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  suspended INTEGER NOT NULL DEFAULT 0,
  UNIQUE (note_id, ord)
);
CREATE INDEX IF NOT EXISTS idx_cards_state_due ON cards(state, due);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  rating INTEGER NOT NULL,
  prev_state TEXT NOT NULL,
  ivl INTEGER NOT NULL DEFAULT 0,
  ease INTEGER NOT NULL DEFAULT 0,
  time_ms INTEGER NOT NULL DEFAULT 0,
  prev TEXT
);
CREATE INDEX IF NOT EXISTS idx_reviews_card ON reviews(card_id);
CREATE INDEX IF NOT EXISTS idx_reviews_ts ON reviews(ts);
`;

const POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS decks (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  created BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_decks_name ON decks (lower(name));
CREATE TABLE IF NOT EXISTS notes (
  id BIGSERIAL PRIMARY KEY,
  deck_id BIGINT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  front TEXT NOT NULL,
  back TEXT NOT NULL,
  extra TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  source_id TEXT,
  created BIGINT NOT NULL,
  modified BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_deck ON notes(deck_id);
CREATE INDEX IF NOT EXISTS idx_notes_source ON notes(source_id);
CREATE TABLE IF NOT EXISTS cards (
  id BIGSERIAL PRIMARY KEY,
  note_id BIGINT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'new',
  due BIGINT NOT NULL DEFAULT 0,
  ivl INTEGER NOT NULL DEFAULT 0,
  ease INTEGER NOT NULL DEFAULT 2500,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  step INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  suspended INTEGER NOT NULL DEFAULT 0,
  UNIQUE (note_id, ord)
);
CREATE INDEX IF NOT EXISTS idx_cards_note ON cards(note_id);
CREATE INDEX IF NOT EXISTS idx_cards_state_due ON cards(state, due);
CREATE TABLE IF NOT EXISTS reviews (
  id BIGSERIAL PRIMARY KEY,
  card_id BIGINT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  ts BIGINT NOT NULL,
  rating INTEGER NOT NULL,
  prev_state TEXT NOT NULL,
  ivl INTEGER NOT NULL DEFAULT 0,
  ease INTEGER NOT NULL DEFAULT 0,
  time_ms INTEGER NOT NULL DEFAULT 0,
  prev TEXT
);
CREATE INDEX IF NOT EXISTS idx_reviews_card ON reviews(card_id);
CREATE INDEX IF NOT EXISTS idx_reviews_ts ON reviews(ts);
`;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

export const isPostgresUrl = (target) => /^postgres(ql)?:\/\//i.test(String(target || ''));

/** Open a database: a postgres:// URL, a file path, or ':memory:'. */
export async function openDatabase(target) {
  return isPostgresUrl(target) ? openPostgres(target) : openSqlite(target);
}

// ---------- SQLite ----------

async function openSqlite(file) {
  const { DatabaseSync } = await import('node:sqlite');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  if (file !== ':memory:') raw.exec('PRAGMA journal_mode = WAL;');
  raw.exec(SQLITE_SCHEMA);

  const api = {
    dialect: 'sqlite',
    async get(sql, ...args) {
      return raw.prepare(sql).get(...args);
    },
    async all(sql, ...args) {
      return raw.prepare(sql).all(...args);
    },
    async run(sql, ...args) {
      const info = raw.prepare(sql).run(...args);
      return { id: Number(info.lastInsertRowid), changes: Number(info.changes) };
    },
    async close() {
      raw.close();
    },
  };
  // node:sqlite is synchronous, so transactions are serialised with a small queue.
  let queue = Promise.resolve();
  api.tx = (fn) => {
    const run = queue.then(async () => {
      raw.exec('BEGIN');
      try {
        const result = await fn(api);
        raw.exec('COMMIT');
        return result;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    });
    queue = run.catch(() => {});
    return run;
  };
  return api;
}

// ---------- Postgres ----------

function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function pgApi(query) {
  return {
    dialect: 'postgres',
    async get(sql, ...args) {
      return (await query(toPg(sql), args)).rows[0];
    },
    async all(sql, ...args) {
      return (await query(toPg(sql), args)).rows;
    },
    async run(sql, ...args) {
      let text = toPg(sql);
      if (/^\s*insert\b/i.test(text) && !/\breturning\b/i.test(text)) text += ' RETURNING id';
      const res = await query(text, args);
      return { id: res.rows[0]?.id ?? null, changes: res.rowCount };
    },
  };
}

async function openPostgres(url) {
  const { default: pg } = await import('pg');
  // BIGINT (timestamps, ids) and NUMERIC come back as strings by default.
  pg.types.setTypeParser(20, (v) => Number(v));
  pg.types.setTypeParser(1700, (v) => Number(v));
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.PG_POOL_MAX) || 3,
    idleTimeoutMillis: 10_000,
    ssl: local ? false : { rejectUnauthorized: false },
  });
  // Several serverless instances may start at once; an advisory lock keeps their
  // CREATE TABLE IF NOT EXISTS statements from racing each other.
  const setup = await pool.connect();
  try {
    await setup.query('BEGIN');
    await setup.query('SELECT pg_advisory_xact_lock(724117)');
    await setup.query(POSTGRES_SCHEMA);
    await setup.query('COMMIT');
  } catch (err) {
    await setup.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    setup.release();
  }
  const api = pgApi((text, args) => pool.query(text, args));
  api.tx = async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(pgApi((text, args) => client.query(text, args)));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  };
  api.close = () => pool.end();
  return api;
}
