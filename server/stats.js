import { dayNumber, dayStart } from './scheduler.js';

const ROLLOVER = 4;

export async function getStats(db, deckId, now = Date.now()) {
  const id = Number(deckId) || 0;
  const deckFilter = id ? 'AND n.deck_id = ?' : '';
  const deckArgs = id ? [id] : [];
  const today = dayNumber(now, ROLLOVER);
  const todayStart = dayStart(today, ROLLOVER);

  // Reverse cards only count for decks that study both directions (ids are numbers from the DB → safe to inline).
  const decks = await db.all('SELECT id, config FROM decks');
  const both = decks.filter((d) => JSON.parse(d.config || '{}').bothDirections).map((d) => Number(d.id));
  const visible = both.length ? `(c.ord = 0 OR n.deck_id IN (${both.join(',')}))` : 'c.ord = 0';
  const from = `FROM cards c JOIN notes n ON n.id = c.note_id WHERE ${visible} ${deckFilter}`;

  const [states, reviews, dueRows, total] = await Promise.all([
    db.get(
      `SELECT
         COUNT(CASE WHEN c.suspended = 1 THEN 1 END) AS suspended,
         COUNT(CASE WHEN c.suspended = 0 AND c.state = 'new' THEN 1 END) AS new_cards,
         COUNT(CASE WHEN c.suspended = 0 AND c.state IN ('learning','relearning') THEN 1 END) AS learning,
         COUNT(CASE WHEN c.suspended = 0 AND c.state = 'review' AND c.ivl < 21 THEN 1 END) AS young,
         COUNT(CASE WHEN c.suspended = 0 AND c.state = 'review' AND c.ivl >= 21 THEN 1 END) AS mature,
         COUNT(*) AS total
       ${from}`,
      ...deckArgs,
    ),
    db.all(
      `SELECT r.ts, r.rating, r.time_ms FROM reviews r JOIN cards c ON c.id = r.card_id
       JOIN notes n ON n.id = c.note_id WHERE r.ts >= ? ${deckFilter} ORDER BY r.ts`,
      dayStart(today - 365, ROLLOVER),
      ...deckArgs,
    ),
    db.all(`SELECT c.due ${from} AND c.suspended = 0 AND c.state != 'new' AND c.due < ?`, ...deckArgs, dayStart(today + 14, ROLLOVER)),
    db.get(
      `SELECT COUNT(*) AS n FROM reviews r JOIN cards c ON c.id = r.card_id JOIN notes n ON n.id = c.note_id WHERE 1 = 1 ${deckFilter}`,
      ...deckArgs,
    ),
  ]);

  const historyStart = dayStart(today - 29, ROLLOVER);
  const history = Array.from({ length: 30 }, (_, i) => ({ day: i - 29, count: 0, correct: 0 }));
  const activeDays = new Set();
  let todayCount = 0;
  let todayCorrect = 0;
  let todayMs = 0;
  for (const r of reviews) {
    const d = dayNumber(r.ts, ROLLOVER);
    activeDays.add(d);
    if (r.ts >= historyStart) {
      const slot = history[d - today + 29];
      if (slot) {
        slot.count++;
        if (r.rating > 1) slot.correct++;
      }
    }
    if (r.ts >= todayStart) {
      todayCount++;
      if (r.rating > 1) todayCorrect++;
      todayMs += r.time_ms;
    }
  }
  let streak = 0;
  for (let d = activeDays.has(today) ? today : today - 1; activeDays.has(d); d--) streak++;

  const forecast = Array.from({ length: 14 }, (_, i) => ({ day: i, count: 0 }));
  for (const { due } of dueRows) forecast[Math.max(0, dayNumber(due, ROLLOVER) - today)].count++;

  return {
    today: { reviews: todayCount, correct: todayCorrect, minutes: Math.round(todayMs / 60000) },
    streak,
    states: {
      suspended: Number(states.suspended),
      new: Number(states.new_cards),
      learning: Number(states.learning),
      young: Number(states.young),
      mature: Number(states.mature),
      total: Number(states.total),
    },
    history,
    forecast,
    totalReviews: Number(total.n),
  };
}
