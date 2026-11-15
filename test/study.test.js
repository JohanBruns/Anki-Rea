import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { openDatabase } from '../server/db.js';
import { createDeck, createNote, listDecks, updateDeck } from '../server/notes.js';
import { DAY, MIN } from '../server/scheduler.js';
import { answer, extendNewCards, nextCard, undo } from '../server/study.js';

// One connection per file: the Postgres test server (PGlite) only serves one client at a time.
let shared;
after(() => shared?.then((db) => db.close()));

async function setup(words = 3, config = {}) {
  shared ||= openDatabase(process.env.TEST_DATABASE_URL || ':memory:');
  const db = await shared;
  const deckId = await createDeck(db, `Spanisch ${Math.random()}`);
  if (Object.keys(config).length) await updateDeck(db, deckId, { config });
  for (let i = 0; i < words; i++) await createNote(db, { deckId, front: `wort${i}`, back: `palabra${i}` });
  return { db, deckId };
}

test('a fresh deck shows new cards in insertion order with interval previews', async () => {
  const { db, deckId } = await setup();
  const r = await nextCard(db, deckId);
  assert.equal(r.done, false);
  assert.equal(r.card.front, 'wort0');
  assert.equal(r.card.back, 'palabra0');
  assert.deepEqual(r.counts, { new: 3, learn: 0, review: 0, newRemaining: 0, total: 3, deadline: null });
  assert.equal(r.previews[3], '10 Min');
});

test('answering moves cards through learning and respects the daily new limit', async () => {
  const { db, deckId } = await setup(3, { newPerDay: 2 });
  const now = Date.now();
  let r = await nextCard(db, deckId, { now });
  assert.equal(r.counts.new, 2);
  r = await answer(db, r.card.id, 3, 1000, now); // wort0 → learning, 10 min
  assert.equal(r.counts.learn, 1);
  assert.equal(r.card.front, 'wort1');
  r = await answer(db, r.card.id, 4, 1000, now); // wort1 → review
  assert.equal(r.counts.new, 0, 'daily limit of 2 reached');
  // Only the learning card is left; it is shown early thanks to the 20-minute learn-ahead.
  assert.equal(r.done, false);
  assert.equal(r.card.front, 'wort0');
  r = await answer(db, r.card.id, 3, 1000, now + 10 * MIN);
  assert.equal(r.done, true);
  assert.equal(r.counts.newRemaining, 1);
  r = await extendNewCards(db, deckId, 10, now);
  assert.equal(r.card.front, 'wort2');
});

test('undo restores the previous card state', async () => {
  const { db, deckId } = await setup(2);
  const first = await nextCard(db, deckId);
  await answer(db, first.card.id, 4);
  const restored = await undo(db, deckId);
  assert.equal(restored.card.id, first.card.id);
  assert.equal(restored.card.state, 'new');
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM reviews WHERE card_id = ?', first.card.id)).n), 0);
  await assert.rejects(() => undo(db, deckId), /nichts zum Rückgängigmachen/i);
});

test('a deadline raises the daily goal so every card is introduced in time', async () => {
  const now = Date.now();
  // 12 cards, only 2 new per day configured, deadline in 3 days → 4 study days, 3 for new cards → 4 per day.
  const deadline = now + 3 * DAY;
  const { db, deckId } = await setup(12, { newPerDay: 2, deadline });
  const r = await nextCard(db, deckId, { now });
  assert.equal(r.counts.deadline.daysLeft, 4);
  assert.equal(r.counts.deadline.newPerDay, 4);
  assert.equal(r.counts.new, 4);
  assert.equal(r.counts.deadline.mastered, 0);

  // A graduated card comes back before the deadline (at most half the remaining time away).
  const after = await answer(db, r.card.id, 4, 1000, now);
  const card = await db.get('SELECT * FROM cards WHERE id = ?', r.card.id);
  assert.equal(card.state, 'review');
  assert.ok(card.due <= now + 1.5 * DAY, 'due before half of the remaining time');
  assert.equal(after.counts.deadline.mastered, 1);

  // Without the deadline the configured limit applies again.
  await updateDeck(db, deckId, { config: { deadline: null } });
  assert.equal((await nextCard(db, deckId, { now })).counts.deadline, null);
});

test('reverse cards only appear when both directions are enabled', async () => {
  const { db, deckId } = await setup(1);
  const total = async () => (await listDecks(db)).find((d) => d.id === deckId).counts.total;
  assert.equal(await total(), 1);
  await updateDeck(db, deckId, { config: { bothDirections: true } });
  assert.equal(await total(), 2);
  const r = await nextCard(db, deckId);
  const second = await answer(db, r.card.id, 4);
  // The sibling (reverse) card is held back for today, like Anki's sibling burying.
  assert.equal(second.done, true);
});

test('"Weiterlernen" keeps going after the day is done: soonest due first, seen cards last', async () => {
  const { db, deckId } = await setup(3, { newPerDay: 3 });
  const now = Date.now();
  let r = await nextCard(db, deckId, { now });
  // Graduate every card straight away with "Einfach" → nothing is due any more today.
  const order = [];
  while (!r.done) {
    order.push(r.card.id);
    r = await answer(db, r.card.id, 4, 1000, now + order.length * 1000);
  }
  assert.equal(r.canStudyAhead, true);

  const before = await db.all('SELECT c.id, c.due FROM cards c JOIN notes n ON n.id = c.note_id WHERE n.deck_id = ?', deckId);
  const later = now + 60 * MIN;
  r = await nextCard(db, deckId, { ahead: true, now: later });
  assert.equal(r.done, false);
  assert.equal(r.ahead, true);
  assert.equal(r.card.id, order[0], 'all were seen today → the one seen longest ago comes first');

  // Every card comes up once before one is repeated, and the session never ends on its own.
  const seen = new Set();
  for (let i = 0; i < 3; i++) {
    seen.add(r.card.id);
    r = await answer(db, r.card.id, 3, 1000, later + (i + 1) * MIN, { ahead: true });
    assert.equal(r.done, false);
  }
  assert.equal(seen.size, 3);

  // Studying ahead never shortens the planned interval.
  for (const { id, due } of before) {
    const card = await db.get('SELECT due FROM cards WHERE id = ?', id);
    assert.ok(card.due >= due, 'not due earlier than before');
  }

  // Cards not seen today come before those seen today, soonest due first.
  const tomorrow = later + DAY;
  const fresh = await db.all('SELECT c.id FROM cards c JOIN notes n ON n.id = c.note_id WHERE n.deck_id = ? AND c.ord = 0 ORDER BY c.id', deckId);
  await db.run('UPDATE cards SET due = ? WHERE id = ?', tomorrow + 5 * DAY, fresh[0].id);
  await db.run('UPDATE cards SET due = ? WHERE id = ?', tomorrow + 2 * DAY, fresh[1].id);
  await db.run('UPDATE cards SET due = ? WHERE id = ?', tomorrow + 9 * DAY, fresh[2].id);
  r = await nextCard(db, deckId, { ahead: true, now: tomorrow });
  assert.equal(r.card.id, fresh[1].id, 'the card due soonest comes first');
});

test('without "Weiterlernen" a finished deck stays finished', async () => {
  const { db, deckId } = await setup(1);
  const r = await nextCard(db, deckId);
  const done = await answer(db, r.card.id, 4);
  assert.equal(done.done, true);
  const again = await nextCard(db, deckId, { ahead: true });
  assert.equal(again.card.id, r.card.id, 'a single-card deck shows its card again');
});
