// Runs only with TEST_DATABASE_URL (npm run test:pg): import, export and stats on Postgres.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabase } from '../server/db.js';
import { parseUpload } from '../server/importers/index.js';
import { parseJsonImport } from '../server/importers/jsonImporter.js';
import { applyImport, exportJson, exportText } from '../server/importService.js';
import { listNotes } from '../server/notes.js';
import { getStats } from '../server/stats.js';
import { answer, nextCard } from '../server/study.js';

const url = process.env.TEST_DATABASE_URL;

test('import → study → stats → export round trip on Postgres', { skip: !url && 'no TEST_DATABASE_URL' }, async () => {
  const db = await openDatabase(url);
  const name = `PG ${Date.now()}`;
  const parsed = parseUpload(Buffer.from('Deutsch\tSpanisch\tBeispiel\nbetteln\tmendigar\tLos niños mendigan.\nverkaufen\tvender\t\n'), `${name}.txt`);
  const result = await applyImport(db, parsed);
  assert.equal(result.added, 2);
  const deckId = result.decks[0].id;
  assert.equal(typeof deckId, 'number');

  let r = await nextCard(db, deckId);
  assert.equal(r.card.front, 'betteln');
  r = await answer(db, r.card.id, 4);
  assert.equal(r.card.front, 'verkaufen');

  const list = await listNotes(db, { deck: deckId, q: 'MENDIG' });
  assert.equal(list.total, 1, 'search is case-insensitive');

  const stats = await getStats(db, deckId);
  assert.equal(stats.today.reviews, 1);
  assert.equal(stats.states.young, 1);
  assert.equal(stats.states.new, 1);

  const backup = await exportJson(db, deckId);
  assert.equal(backup.decks[0].notes[0].cards[0].reviews.length, 1);
  assert.match(await exportText(db, deckId), /betteln\tmendigar/);

  // Restoring the backup into the same deck must not duplicate anything.
  const again = await applyImport(db, parseJsonImport(JSON.stringify(backup), 'b.json'), { progress: true });
  assert.equal(again.added, 0);
  await db.close();
});
