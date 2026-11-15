import { HttpError } from './db.js';
import { MIN, answerCard, dayNumber, dayStart, isDeadlineActive, previewIntervals, withDefaults } from './scheduler.js';

// Cards that take part in studying: not suspended, and reverse cards only when enabled.
const VISIBLE = 'c.suspended = 0 AND (c.ord = 0 OR ? = 1)';
const CARD_SELECT = `SELECT c.*, n.front, n.back, n.extra, n.tags, n.deck_id
  FROM cards c JOIN notes n ON n.id = c.note_id`;

export async function getDeck(db, id) {
  const deckId = Number(id);
  if (!Number.isSafeInteger(deckId)) return null;
  const row = await db.get('SELECT * FROM decks WHERE id = ?', deckId);
  if (!row) return null;
  return { id: row.id, name: row.name, created: row.created, config: withDefaults(JSON.parse(row.config || '{}')) };
}

export async function requireDeck(db, id) {
  const deck = await getDeck(db, id);
  if (!deck) throw new HttpError(404, 'Stapel nicht gefunden');
  return deck;
}

function dayWindow(deck, now) {
  const cfg = deck.config;
  const today = dayNumber(now, cfg.rolloverHour);
  return {
    cfg,
    today,
    start: dayStart(today, cfg.rolloverHour),
    end: dayStart(today + 1, cfg.rolloverHour),
    both: cfg.bothDirections ? 1 : 0,
    deadline: isDeadlineActive(cfg, now) ? Number(cfg.deadline) : null,
  };
}

/**
 * Daily goal in deadline mode: all new cards must have been introduced one study day before
 * the deadline (on the last day only repetition), so the pace is spread over the remaining days.
 */
function deadlinePlan(w, newAtStartOfToday) {
  const deadlineDay = dayNumber(w.deadline, w.cfg.rolloverHour);
  const daysLeft = Math.max(1, deadlineDay - w.today + 1); // incl. today and the deadline day
  const introDays = Math.max(1, daysLeft - 1);
  return { daysLeft, newTarget: Math.ceil(newAtStartOfToday / introDays) };
}

export async function deckCounts(db, deck, now = Date.now()) {
  const w = dayWindow(deck, now);
  const [done, cards] = await Promise.all([
    db.get(
      `SELECT COUNT(DISTINCT CASE WHEN r.prev_state = 'new' THEN r.card_id END) AS new_done,
              COUNT(CASE WHEN r.prev_state = 'review' THEN 1 END) AS rev_done
       FROM reviews r JOIN cards c ON c.id = r.card_id JOIN notes nt ON nt.id = c.note_id
       WHERE nt.deck_id = ? AND r.ts >= ?`,
      deck.id,
      w.start,
    ),
    db.get(
      `SELECT COUNT(CASE WHEN c.suspended = 0 AND c.state = 'new' THEN 1 END) AS new_avail,
              COUNT(CASE WHEN c.suspended = 0 AND c.state IN ('learning','relearning') AND c.due < ? THEN 1 END) AS learn,
              COUNT(CASE WHEN c.suspended = 0 AND c.state = 'review' AND c.due <= ? THEN 1 END) AS rev_due,
              COUNT(CASE WHEN c.suspended = 0 AND c.state = 'review' THEN 1 END) AS mastered,
              COUNT(CASE WHEN c.suspended = 0 THEN 1 END) AS active,
              COUNT(*) AS total
       FROM cards c JOIN notes nt ON nt.id = c.note_id
       WHERE nt.deck_id = ? AND (c.ord = 0 OR ? = 1)`,
      w.end,
      now,
      deck.id,
      w.both,
    ),
  ]);
  const newDone = Number(done.new_done);
  const newAvail = Number(cards.new_avail);
  const extraNew = w.cfg.todayExtra?.day === w.today ? w.cfg.todayExtra.newCards || 0 : 0;
  let perDay = w.cfg.newPerDay;
  let reviewLimit = w.cfg.reviewsPerDay;
  let deadline = null;
  if (w.deadline) {
    const plan = deadlinePlan(w, newAvail + newDone);
    perDay = Math.max(perDay, plan.newTarget);
    reviewLimit = Infinity; // before an exam every due repetition counts
    deadline = {
      at: w.deadline,
      daysLeft: plan.daysLeft,
      newPerDay: perDay,
      mastered: Number(cards.mastered),
      active: Number(cards.active),
    };
  }
  const newLimit = Math.max(0, perDay + extraNew - newDone);
  const revLimit = Math.max(0, reviewLimit - Number(done.rev_done));
  return {
    new: Math.min(newAvail, newLimit),
    learn: Number(cards.learn),
    review: Math.min(Number(cards.rev_due), revLimit),
    newRemaining: Math.max(0, newAvail - newLimit),
    total: Number(cards.total),
    deadline,
  };
}

function rowToCard(row) {
  return {
    id: row.id,
    state: row.state,
    due: row.due,
    ivl: row.ivl,
    ease: row.ease,
    reps: row.reps,
    lapses: row.lapses,
    step: row.step,
  };
}

function cardPayload(row, cfg) {
  const forward = row.ord === 0;
  return {
    id: row.id,
    noteId: row.note_id,
    ord: row.ord,
    state: row.state,
    front: forward ? row.front : row.back,
    back: forward ? row.back : row.front,
    extra: row.extra,
    tags: row.tags,
    frontLabel: forward ? cfg.frontLabel : cfg.backLabel,
    backLabel: forward ? cfg.backLabel : cfg.frontLabel,
    extraLabel: cfg.extraLabel,
    frontLang: forward ? cfg.frontLang : cfg.backLang,
    backLang: forward ? cfg.backLang : cfg.frontLang,
  };
}

function deckInfo(deck) {
  return { id: deck.id, name: deck.name, autoplay: !!deck.config.autoplay, deadline: deck.config.deadline || null };
}

/** Pick the next card to study, mirroring Anki's queue order: due learning → reviews/new mixed → learn-ahead. */
export async function nextCard(db, deckId, { exclude = 0, cardId = 0, ahead = false, now = Date.now() } = {}) {
  const deck = await requireDeck(db, deckId);
  const counts = await deckCounts(db, deck, now);
  const w = dayWindow(deck, now);
  const one = (where, order, ...args) =>
    db.get(`${CARD_SELECT} WHERE n.deck_id = ? AND ${VISIBLE} AND ${where} ORDER BY ${order} LIMIT 1`, deck.id, w.both, ...args);
  const learnAhead = now + w.cfg.learnAheadMin * MIN;

  let row = null;
  if (cardId) row = (await db.get(`${CARD_SELECT} WHERE c.id = ? AND n.deck_id = ?`, Number(cardId), deck.id)) || null;
  if (!row) row = await one(`c.state IN ('learning','relearning') AND c.due <= ? AND c.id != ?`, 'c.due', now, exclude);
  if (!row) {
    const pickNew = () =>
      counts.new > 0
        ? one(
            `c.state = 'new' AND c.id != ? AND c.note_id NOT IN
              (SELECT c2.note_id FROM cards c2 JOIN reviews r ON r.card_id = c2.id WHERE r.ts >= ?)`,
            'c.position, c.id',
            exclude,
            w.start,
          )
        : null;
    const pickReview = () =>
      counts.review > 0 ? one(`c.state = 'review' AND c.due <= ? AND c.id != ?`, 'c.due, c.id', now, exclude) : null;
    const preferNew = counts.new > 0 && (counts.review === 0 || Math.random() < counts.new / (counts.new + counts.review));
    row = preferNew ? (await pickNew()) || (await pickReview()) : (await pickReview()) || (await pickNew());
  }
  // In deadline mode reviews are also scheduled to the hour, so they may be pulled forward like learning cards.
  const aheadStates = w.deadline ? "('learning','relearning','review')" : "('learning','relearning')";
  if (!row) row = await one(`c.state IN ${aheadStates} AND c.due <= ? AND c.id != ?`, 'c.due', learnAhead, exclude);
  if (!row) row = await one(`c.state IN ${aheadStates} AND c.due <= ?`, 'c.due', learnAhead);
  if (!row && ahead) row = await pickAhead(db, deck, w, exclude);

  if (!row) {
    const extra = await db.get(
      `SELECT COUNT(*) AS n FROM cards c JOIN notes n ON n.id = c.note_id WHERE n.deck_id = ? AND ${VISIBLE}`,
      deck.id,
      w.both,
    );
    const next = await db.get(
      `SELECT MIN(c.due) AS d FROM cards c JOIN notes n ON n.id = c.note_id
       WHERE n.deck_id = ? AND ${VISIBLE} AND c.state IN ${aheadStates} AND c.due > ? AND c.due < ?`,
      deck.id,
      w.both,
      now,
      w.deadline ? Math.min(w.deadline, now + 2 * 86_400_000) : w.end,
    );
    return { done: true, deck: deckInfo(deck), counts, nextDue: next?.d ?? null, canStudyAhead: Number(extra.n) > 0 };
  }
  return {
    done: false,
    ahead: !!ahead,
    deck: deckInfo(deck),
    counts,
    card: cardPayload(row, deck.config),
    previews: previewIntervals(rowToCard(row), deck.config, now),
  };
}

/**
 * "Weiterlernen" after the day's work is done: cards that are not due yet, soonest first.
 * Cards already seen today go to the back (least recently seen first), so the session works
 * through the whole deck instead of repeating the same few cards. New cards come last.
 */
async function pickAhead(db, deck, w, exclude) {
  const row = await db.get(
    `${CARD_SELECT}
     LEFT JOIN (SELECT card_id, MAX(ts) AS last_ts FROM reviews GROUP BY card_id) lr ON lr.card_id = c.id
     WHERE n.deck_id = ? AND ${VISIBLE} AND c.state IN ('learning','relearning','review') AND c.id != ?
     ORDER BY CASE WHEN lr.last_ts >= ? THEN 1 ELSE 0 END,
              CASE WHEN lr.last_ts >= ? THEN lr.last_ts ELSE c.due END,
              c.id
     LIMIT 1`,
    deck.id,
    w.both,
    exclude,
    w.start,
    w.start,
  );
  if (row) return row;
  const fresh = await db.get(
    `${CARD_SELECT} WHERE n.deck_id = ? AND ${VISIBLE} AND c.state = 'new' AND c.id != ? ORDER BY c.position, c.id LIMIT 1`,
    deck.id,
    w.both,
    exclude,
  );
  // A deck with a single card: show it again rather than ending the session.
  return fresh || (exclude ? pickAhead(db, deck, w, 0) : null);
}

const UPDATE_CARD = 'UPDATE cards SET state = ?, due = ?, ivl = ?, ease = ?, reps = ?, lapses = ?, step = ? WHERE id = ?';

export async function answer(db, cardId, rating, timeMs = 0, now = Date.now(), { ahead = false } = {}) {
  if (![1, 2, 3, 4].includes(rating)) throw new HttpError(400, 'Ungültige Bewertung');
  const row = await db.get(`${CARD_SELECT} WHERE c.id = ?`, Number(cardId) || 0);
  if (!row) throw new HttpError(404, 'Karte nicht gefunden');
  const deck = await requireDeck(db, row.deck_id);
  const before = rowToCard(row);
  const after = answerCard(before, rating, deck.config, now);
  await db.tx(async (t) => {
    await t.run(UPDATE_CARD, after.state, after.due, after.ivl, after.ease, after.reps, after.lapses, after.step, row.id);
    await t.run(
      'INSERT INTO reviews (card_id, ts, rating, prev_state, ivl, ease, time_ms, prev) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      row.id,
      now,
      rating,
      before.state,
      after.state === 'review' ? after.ivl : 0,
      after.ease,
      Math.min(Math.max(0, Math.round(Number(timeMs) || 0)), 600_000),
      JSON.stringify(before),
    );
  });
  return nextCard(db, row.deck_id, { exclude: row.id, ahead, now });
}

export async function undo(db, deckId, { ahead = false } = {}) {
  const deck = await requireDeck(db, deckId);
  const r = await db.get(
    `SELECT r.* FROM reviews r JOIN cards c ON c.id = r.card_id JOIN notes n ON n.id = c.note_id
     WHERE n.deck_id = ? AND r.prev IS NOT NULL ORDER BY r.id DESC LIMIT 1`,
    deck.id,
  );
  if (!r) throw new HttpError(400, 'Es gibt nichts zum Rückgängigmachen.');
  const p = JSON.parse(r.prev);
  await db.tx(async (t) => {
    await t.run(UPDATE_CARD, p.state, p.due, p.ivl, p.ease, p.reps, p.lapses, p.step, r.card_id);
    await t.run('DELETE FROM reviews WHERE id = ?', r.id);
  });
  return nextCard(db, deck.id, { cardId: r.card_id, ahead });
}

export async function extendNewCards(db, deckId, amount, now = Date.now()) {
  const deck = await requireDeck(db, deckId);
  const today = dayNumber(now, deck.config.rolloverHour);
  const prev = deck.config.todayExtra?.day === today ? deck.config.todayExtra.newCards || 0 : 0;
  const stored = JSON.parse((await db.get('SELECT config FROM decks WHERE id = ?', deck.id)).config || '{}');
  stored.todayExtra = { day: today, newCards: prev + Math.max(1, Math.min(500, Number(amount) || 10)) };
  await db.run('UPDATE decks SET config = ? WHERE id = ?', JSON.stringify(stored), deck.id);
  return nextCard(db, deck.id, { now });
}

export async function setSuspended(db, cardId, suspended, { ahead = false } = {}) {
  const row = await db.get(`${CARD_SELECT} WHERE c.id = ?`, Number(cardId) || 0);
  if (!row) throw new HttpError(404, 'Karte nicht gefunden');
  await db.run('UPDATE cards SET suspended = ? WHERE id = ?', suspended ? 1 : 0, row.id);
  return nextCard(db, row.deck_id, { exclude: row.id, ahead });
}
