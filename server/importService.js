import crypto from 'node:crypto';
import { HttpError } from './db.js';
import { parseUpload } from './importers/index.js';
import { findOrCreateDeck, insertNote } from './notes.js';
import { getDeck } from './study.js';

// Previews are kept briefly between "Vorschau" and "Importieren". On serverless hosting the two
// requests may hit different instances, so the client also sends the file again on commit (see api.js).
const PREVIEW_TTL = 30 * 60_000;
const previews = new Map();

const normalize = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const noteKey = (n) => `${normalize(n.front)}\u0001${normalize(n.back)}`;

export function parseOrFail(buf, filename) {
  let parsed;
  try {
    parsed = parseUpload(buf, filename);
  } catch (err) {
    throw new HttpError(400, err.message || 'Die Datei konnte nicht gelesen werden.');
  }
  const total = parsed.decks.reduce((s, d) => s + d.notes.length, 0);
  if (!total) {
    throw new HttpError(400, 'In der Datei wurden keine Karten gefunden. Jede Zeile braucht mindestens zwei Spalten (Wort und Übersetzung).');
  }
  return parsed;
}

export function previewImport(buf, filename) {
  const parsed = parseOrFail(buf, filename);
  const now = Date.now();
  for (const [k, v] of previews) if (v.expires < now) previews.delete(k);
  const token = crypto.randomUUID();
  previews.set(token, { parsed, expires: now + PREVIEW_TTL });
  return {
    token,
    format: parsed.format,
    formatLabel: parsed.formatLabel,
    hasProgress: parsed.hasProgress && parsed.decks.some((d) => d.notes.some((n) => n.cards?.some((c) => c.reps > 0))),
    total: parsed.decks.reduce((s, d) => s + d.notes.length, 0),
    warnings: parsed.warnings || [],
    decks: parsed.decks.map((d) => ({
      name: d.name,
      count: d.notes.length,
      labels: { front: d.config?.frontLabel || 'Vorderseite', back: d.config?.backLabel || 'Rückseite', extra: d.config?.extraLabel || 'Beispiel' },
      sample: d.notes.slice(0, 6).map((n) => ({ front: n.front, back: n.back, extra: n.extra })),
    })),
  };
}

/**
 * Store parsed notes. Duplicates (same Anki note id, or same front + back in the deck) are not added twice;
 * a known Anki note gets its text updated instead.
 * opts: { deckId?: existing deck for everything, deckName?: name for a single new deck, progress?: keep learning progress }
 */
export async function applyImport(db, parsed, opts = {}) {
  const now = Date.now();
  const result = { added: 0, updated: 0, skipped: 0, decks: [] };
  await db.tx(async (t) => {
    for (const pd of parsed.decks) {
      let deckId;
      if (opts.deckId) {
        const target = await getDeck(t, opts.deckId);
        if (!target) throw new HttpError(404, 'Zielstapel nicht gefunden');
        deckId = target.id;
      } else {
        const name = parsed.decks.length === 1 && opts.deckName ? opts.deckName : pd.name;
        deckId = (await findOrCreateDeck(t, name, pd.config || {})).id;
      }
      const deck = await getDeck(t, deckId);
      if (!result.decks.some((d) => d.id === deckId)) result.decks.push({ id: deckId, name: deck.name });

      const existing = await t.all('SELECT id, front, back, extra, tags, source_id FROM notes WHERE deck_id = ?', deckId);
      const bySource = new Map(existing.filter((n) => n.source_id).map((n) => [n.source_id, n]));
      const byKey = new Map(existing.map((n) => [noteKey(n), n]));
      const maxPos = await t.get(
        'SELECT COALESCE(MAX(c.position), 0) AS p FROM cards c JOIN notes n ON n.id = c.note_id WHERE n.deck_id = ?',
        deckId,
      );
      let position = Number(maxPos.p) + 1;

      for (const note of pd.notes) {
        const match = (note.sourceId && bySource.get(note.sourceId)) || null;
        if (match) {
          const changed =
            match.front !== note.front || match.back !== note.back || match.extra !== (note.extra || '') || match.tags !== (note.tags || '');
          if (changed) {
            await t.run(
              'UPDATE notes SET front = ?, back = ?, extra = ?, tags = ?, modified = ? WHERE id = ?',
              note.front,
              note.back,
              note.extra || '',
              note.tags || '',
              now,
              match.id,
            );
            result.updated++;
          } else result.skipped++;
          continue;
        }
        if (byKey.has(noteKey(note))) {
          result.skipped++;
          continue;
        }
        const cards = opts.progress ? note.cards || [] : [];
        const id = await insertNote(t, deckId, { ...note, cards }, { position: position++, startingEase: deck.config.startingEase, now });
        const stored = { id, front: note.front, back: note.back, source_id: note.sourceId };
        byKey.set(noteKey(note), stored);
        if (note.sourceId) bySource.set(note.sourceId, stored);
        result.added++;
      }
    }
  });
  return result;
}

/** Commit a previewed import. `parsed` is used when the preview lives on another server instance. */
export async function commitImport(db, { token, deckId, deckName, progress }, parsed = null) {
  const entry = previews.get(token);
  const data = entry?.parsed || parsed;
  if (!data) throw new HttpError(410, 'Die Vorschau ist abgelaufen. Bitte die Datei erneut auswählen.');
  const result = await applyImport(db, data, { deckId: deckId ? Number(deckId) : null, deckName, progress: !!progress });
  previews.delete(token);
  return result;
}

// ---------- export ----------

export async function exportJson(db, deckId) {
  const id = Number(deckId) || 0;
  const decks = await db.all(`SELECT * FROM decks ${id ? 'WHERE id = ?' : ''} ORDER BY lower(name)`, ...(id ? [id] : []));
  const filter = id ? 'WHERE n.deck_id = ?' : '';
  const args = id ? [id] : [];
  const [notes, cards, reviews] = await Promise.all([
    db.all(`SELECT n.* FROM notes n ${filter} ORDER BY n.id`, ...args),
    db.all(`SELECT c.* FROM cards c JOIN notes n ON n.id = c.note_id ${filter} ORDER BY c.note_id, c.ord`, ...args),
    db.all(
      `SELECT r.card_id, r.ts, r.rating, r.prev_state, r.ivl, r.ease, r.time_ms FROM reviews r
       JOIN cards c ON c.id = r.card_id JOIN notes n ON n.id = c.note_id ${filter} ORDER BY r.ts`,
      ...args,
    ),
  ]);
  const group = (rows, key) => {
    const map = new Map();
    for (const r of rows) (map.get(r[key]) || map.set(r[key], []).get(r[key])).push(r);
    return map;
  };
  const notesByDeck = group(notes, 'deck_id');
  const cardsByNote = group(cards, 'note_id');
  const reviewsByCard = group(reviews, 'card_id');
  return {
    app: 'anki-rea',
    version: 1,
    exported: new Date().toISOString(),
    decks: decks.map((d) => ({
      name: d.name,
      config: JSON.parse(d.config || '{}'),
      notes: (notesByDeck.get(d.id) || []).map((n) => ({
        front: n.front,
        back: n.back,
        extra: n.extra,
        tags: n.tags,
        sourceId: n.source_id,
        cards: (cardsByNote.get(n.id) || []).map((c) => ({
          ord: c.ord,
          state: c.state,
          due: c.due,
          ivl: c.ivl,
          ease: c.ease,
          reps: c.reps,
          lapses: c.lapses,
          step: c.step,
          position: c.position,
          suspended: !!c.suspended,
          reviews: (reviewsByCard.get(c.id) || []).map((r) => ({
            ts: r.ts,
            rating: r.rating,
            prevState: r.prev_state,
            ivl: r.ivl,
            ease: r.ease,
            timeMs: r.time_ms,
          })),
        })),
      })),
    })),
  };
}

/** Tab-separated text in the format Anki's "Datei → Importieren" understands. */
export async function exportText(db, deckId) {
  const id = Number(deckId) || 0;
  const cell = (s) => {
    const v = String(s ?? '');
    return /[\t\n"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const rows = await db.all(
    `SELECT n.front, n.back, n.extra, n.tags, d.name AS deck FROM notes n JOIN decks d ON d.id = n.deck_id
     ${id ? 'WHERE n.deck_id = ?' : ''} ORDER BY lower(d.name), n.id`,
    ...(id ? [id] : []),
  );
  const lines = ['#separator:tab', '#html:false', '#deck column:5', '#tags column:4'];
  for (const r of rows) lines.push([r.front, r.back, r.extra, r.tags, r.deck.replace(/ › /g, '::')].map(cell).join('\t'));
  return `${lines.join('\n')}\n`;
}
