import { HttpError } from './db.js';
import { DEFAULT_CONFIG, dayNumber } from './scheduler.js';
import { deckCounts, getDeck, requireDeck } from './study.js';

const clean = (v, max = 5000) => String(v ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
const toId = (v) => (Number.isSafeInteger(Number(v)) ? Number(v) : 0);

// ---------- decks ----------

export async function listDecks(db, now = Date.now()) {
  const rows = await db.all('SELECT id FROM decks ORDER BY lower(name)');
  return Promise.all(
    rows.map(async ({ id }) => {
      const deck = await getDeck(db, id);
      return { id: deck.id, name: deck.name, counts: await deckCounts(db, deck, now) };
    }),
  );
}

export async function findOrCreateDeck(db, name, config = {}) {
  const deckName = clean(name, 200) || 'Neuer Stapel';
  const existing = await db.get('SELECT id FROM decks WHERE lower(name) = lower(?)', deckName);
  if (existing) return { id: existing.id, created: false };
  const info = await db.run(
    'INSERT INTO decks (name, config, created) VALUES (?, ?, ?)',
    deckName,
    JSON.stringify(sanitizeConfig(config)),
    Date.now(),
  );
  return { id: info.id, created: true };
}

export async function createDeck(db, name) {
  const deckName = clean(name, 200);
  if (!deckName) throw new HttpError(400, 'Bitte einen Namen eingeben.');
  if (await db.get('SELECT 1 AS x FROM decks WHERE lower(name) = lower(?)', deckName)) {
    throw new HttpError(409, 'Ein Stapel mit diesem Namen existiert bereits.');
  }
  return (await findOrCreateDeck(db, deckName)).id;
}

const NUMBER_LIMITS = {
  newPerDay: [0, 9999],
  reviewsPerDay: [0, 99999],
  graduatingIvl: [1, 365],
  easyIvl: [1, 3650],
  startingEase: [1300, 5000],
  easyBonus: [1, 5],
  hardFactor: [0.5, 3],
  ivlModifier: [0.1, 5],
  lapseIvlFactor: [0, 1],
  minLapseIvl: [1, 365],
  maxIvl: [1, 36500],
  learnAheadMin: [0, 240],
};
const STRING_KEYS = ['frontLabel', 'backLabel', 'extraLabel', 'frontLang', 'backLang'];

export function sanitizeConfig(input = {}) {
  const out = {};
  for (const [key, [lo, hi]] of Object.entries(NUMBER_LIMITS)) {
    if (input[key] === undefined || input[key] === null || input[key] === '') continue;
    const v = Number(input[key]);
    if (Number.isFinite(v)) out[key] = Math.min(hi, Math.max(lo, v));
  }
  for (const key of ['learnSteps', 'relearnSteps']) {
    if (input[key] === undefined) continue;
    const arr = Array.isArray(input[key]) ? input[key] : String(input[key]).split(/[\s,;]+/);
    out[key] = arr
      .map(Number)
      .filter((v) => Number.isFinite(v) && v > 0)
      .slice(0, 12)
      .map((v) => Math.min(v, 60 * 24 * 30));
  }
  for (const key of STRING_KEYS) if (input[key] !== undefined) out[key] = clean(input[key], 60);
  for (const key of ['bothDirections', 'autoplay']) if (input[key] !== undefined) out[key] = !!input[key];
  if (input.todayExtra && typeof input.todayExtra === 'object') out.todayExtra = input.todayExtra;
  if (input.deadline !== undefined) {
    const v = Number(input.deadline);
    out.deadline = input.deadline && Number.isFinite(v) && v > 0 ? Math.round(v) : null;
  }
  return out;
}

export async function deckDetails(db, id) {
  const deck = await requireDeck(db, id);
  return { id: deck.id, name: deck.name, config: deck.config, counts: await deckCounts(db, deck), defaults: DEFAULT_CONFIG };
}

export async function updateDeck(db, id, { name, config }) {
  const deck = await requireDeck(db, id);
  if (name !== undefined) {
    const deckName = clean(name, 200);
    if (!deckName) throw new HttpError(400, 'Der Name darf nicht leer sein.');
    const clash = await db.get('SELECT id FROM decks WHERE lower(name) = lower(?) AND id != ?', deckName, deck.id);
    if (clash) throw new HttpError(409, 'Ein Stapel mit diesem Namen existiert bereits.');
    await db.run('UPDATE decks SET name = ? WHERE id = ?', deckName, deck.id);
  }
  if (config !== undefined) {
    const stored = JSON.parse((await db.get('SELECT config FROM decks WHERE id = ?', deck.id)).config || '{}');
    await db.run('UPDATE decks SET config = ? WHERE id = ?', JSON.stringify({ ...stored, ...sanitizeConfig(config) }), deck.id);
  }
  return deckDetails(db, deck.id);
}

export async function deleteDeck(db, id) {
  const deck = await requireDeck(db, id);
  await db.run('DELETE FROM decks WHERE id = ?', deck.id);
}

// ---------- notes ----------

async function nextPosition(db, deckId) {
  const row = await db.get(
    'SELECT COALESCE(MAX(c.position), 0) AS p FROM cards c JOIN notes n ON n.id = c.note_id WHERE n.deck_id = ?',
    deckId,
  );
  return Number(row.p) + 1;
}

/** Insert a note with its forward (ord 0) and reverse (ord 1) card. note.cards: optional progress per ord. */
export async function insertNote(db, deckId, note, { position, startingEase = 2500, now = Date.now() } = {}) {
  const { id: noteId } = await db.run(
    'INSERT INTO notes (deck_id, front, back, extra, tags, source_id, created, modified) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    deckId,
    clean(note.front),
    clean(note.back),
    clean(note.extra),
    clean(note.tags, 500),
    note.sourceId || null,
    now,
    now,
  );
  const pos = position ?? (await nextPosition(db, deckId));
  for (const ord of [0, 1]) {
    const c = (note.cards || []).find((x) => x.ord === ord) || {};
    const state = ['new', 'learning', 'review', 'relearning'].includes(c.state) ? c.state : 'new';
    const { id: cardId } = await db.run(
      `INSERT INTO cards (note_id, ord, state, due, ivl, ease, reps, lapses, step, position, suspended)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      noteId,
      ord,
      state,
      state === 'new' ? 0 : Math.round(Number(c.due) || now),
      Math.max(0, Math.round(Number(c.ivl) || 0)),
      Math.round(Number(c.ease) || startingEase),
      Math.max(0, Math.round(Number(c.reps) || 0)),
      Math.max(0, Math.round(Number(c.lapses) || 0)),
      Math.max(0, Math.round(Number(c.step) || 0)),
      pos,
      c.suspended ? 1 : 0,
    );
    for (const r of c.reviews || []) {
      await db.run(
        'INSERT INTO reviews (card_id, ts, rating, prev_state, ivl, ease, time_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
        cardId,
        Math.round(Number(r.ts)),
        Math.min(4, Math.max(1, Math.round(Number(r.rating) || 3))),
        r.prevState || 'review',
        Math.round(Number(r.ivl) || 0),
        Math.round(Number(r.ease) || 0),
        Math.round(Number(r.timeMs) || 0),
      );
    }
  }
  return noteId;
}

async function noteRow(db, id) {
  const note = await db.get('SELECT * FROM notes WHERE id = ?', toId(id));
  if (!note) throw new HttpError(404, 'Karte nicht gefunden');
  return note;
}

function cardSummary(c, now, rollover = DEFAULT_CONFIG.rolloverHour) {
  const today = dayNumber(now, rollover);
  return {
    id: c.id,
    ord: c.ord,
    state: c.state,
    due: c.due,
    dueDays: c.state === 'review' ? dayNumber(c.due, rollover) - today : null,
    ivl: c.ivl,
    ease: c.ease,
    reps: c.reps,
    lapses: c.lapses,
    suspended: !!c.suspended,
  };
}

export async function getNote(db, id, now = Date.now()) {
  const note = await noteRow(db, id);
  const cards = await db.all('SELECT * FROM cards WHERE note_id = ? ORDER BY ord', note.id);
  return {
    id: note.id,
    deckId: note.deck_id,
    front: note.front,
    back: note.back,
    extra: note.extra,
    tags: note.tags,
    created: note.created,
    modified: note.modified,
    cards: cards.map((c) => cardSummary(c, now)),
  };
}

export async function listNotes(db, { deck, q, offset = 0, limit = 50 } = {}, now = Date.now()) {
  const where = [];
  const args = [];
  if (deck) {
    where.push('n.deck_id = ?');
    args.push(toId(deck));
  }
  if (q) {
    const like = `%${String(q).toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    where.push(
      "(lower(n.front) LIKE ? ESCAPE '\\' OR lower(n.back) LIKE ? ESCAPE '\\' OR lower(n.extra) LIKE ? ESCAPE '\\' OR lower(n.tags) LIKE ? ESCAPE '\\')",
    );
    args.push(like, like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [count, rows] = await Promise.all([
    db.get(`SELECT COUNT(*) AS total FROM notes n ${whereSql}`, ...args),
    db.all(
      `SELECT n.id, n.deck_id, n.front, n.back, n.extra, n.tags, d.name AS deck_name,
              c.id AS card_id, c.ord, c.state, c.due, c.ivl, c.ease, c.reps, c.lapses, c.suspended
       FROM notes n JOIN decks d ON d.id = n.deck_id LEFT JOIN cards c ON c.note_id = n.id AND c.ord = 0
       ${whereSql} ORDER BY n.id DESC LIMIT ? OFFSET ?`,
      ...args,
      Math.min(200, Number(limit) || 50),
      Math.max(0, Number(offset) || 0),
    ),
  ]);
  return {
    total: Number(count.total),
    notes: rows.map((r) => ({
      id: r.id,
      deckId: r.deck_id,
      deckName: r.deck_name,
      front: r.front,
      back: r.back,
      extra: r.extra,
      tags: r.tags,
      card: r.card_id ? cardSummary({ ...r, id: r.card_id }, now) : null,
    })),
  };
}

function validateNote(input) {
  const front = clean(input.front);
  const back = clean(input.back);
  if (!front || !back) throw new HttpError(400, 'Vorder- und Rückseite dürfen nicht leer sein.');
  return { front, back, extra: clean(input.extra), tags: clean(input.tags, 500) };
}

export async function createNote(db, input) {
  const deck = await requireDeck(db, input.deckId);
  const note = validateNote(input);
  const id = await db.tx((t) => insertNote(t, deck.id, note, { startingEase: deck.config.startingEase }));
  return getNote(db, id);
}

export async function updateNote(db, id, input) {
  const existing = await noteRow(db, id);
  const note = validateNote({ ...existing, ...input });
  const deckId = input.deckId !== undefined ? (await requireDeck(db, input.deckId)).id : existing.deck_id;
  await db.run(
    'UPDATE notes SET front = ?, back = ?, extra = ?, tags = ?, deck_id = ?, modified = ? WHERE id = ?',
    note.front,
    note.back,
    note.extra,
    note.tags,
    deckId,
    Date.now(),
    existing.id,
  );
  if (input.suspended !== undefined) {
    await db.run('UPDATE cards SET suspended = ? WHERE note_id = ?', input.suspended ? 1 : 0, existing.id);
  }
  return getNote(db, existing.id);
}

export async function deleteNote(db, id) {
  const note = await noteRow(db, id);
  await db.run('DELETE FROM notes WHERE id = ?', note.id);
}

export async function resetNote(db, id) {
  const note = await noteRow(db, id);
  const deck = await getDeck(db, note.deck_id);
  const position = await nextPosition(db, note.deck_id);
  await db.tx(async (t) => {
    await t.run(
      "UPDATE cards SET state = 'new', due = 0, ivl = 0, ease = ?, reps = 0, lapses = 0, step = 0, position = ? WHERE note_id = ?",
      deck.config.startingEase,
      position,
      note.id,
    );
    await t.run('UPDATE reviews SET prev = NULL WHERE card_id IN (SELECT id FROM cards WHERE note_id = ?)', note.id);
  });
  return getNote(db, note.id);
}
