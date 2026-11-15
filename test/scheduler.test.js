import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DAY, MIN, answerCard, dayNumber, dayStart, formatInterval, previewIntervals } from '../server/scheduler.js';

const NOW = new Date(2026, 10, 15, 18, 0).getTime(); // 15.11.2026 18:00 local
const today = dayNumber(NOW);
const newCard = { id: 1, state: 'new', due: 0, ivl: 0, ease: 2500, reps: 0, lapses: 0, step: 0 };

test('day boundaries follow the 4:00 rollover', () => {
  const lateNight = new Date(2026, 10, 16, 2, 0).getTime();
  assert.equal(dayNumber(lateNight), today, '02:00 still belongs to the previous day');
  assert.equal(dayNumber(new Date(2026, 10, 16, 4, 0).getTime()), today + 1);
  assert.equal(new Date(dayStart(today)).getHours(), 4);
  assert.equal(dayNumber(dayStart(today + 3)), today + 3);
});

test('new card walks through learning steps 1m → 10m → 1 day', () => {
  const again = answerCard(newCard, 1, {}, NOW);
  assert.equal(again.state, 'learning');
  assert.equal(again.due, NOW + 1 * MIN);

  const hard = answerCard(newCard, 2, {}, NOW);
  assert.equal(hard.due, NOW + 5.5 * MIN, 'hard on the first step averages the first two steps');

  const good = answerCard(newCard, 3, {}, NOW);
  assert.equal(good.state, 'learning');
  assert.equal(good.step, 1);
  assert.equal(good.due, NOW + 10 * MIN);

  const graduated = answerCard(good, 3, {}, NOW + 10 * MIN);
  assert.equal(graduated.state, 'review');
  assert.equal(graduated.ivl, 1);
  assert.equal(graduated.due, dayStart(today + 1));
  assert.equal(graduated.reps, 2);
});

test('easy on a new card graduates straight to the easy interval', () => {
  const easy = answerCard(newCard, 4, {}, NOW);
  assert.equal(easy.state, 'review');
  assert.ok(easy.ivl >= 3 && easy.ivl <= 5, `ivl ${easy.ivl}`);
});

test('review intervals grow with ease and keep hard < good < easy', () => {
  const card = { id: 7, state: 'review', due: dayStart(today), ivl: 10, ease: 2500, reps: 5, lapses: 0, step: 0 };
  const hard = answerCard(card, 2, {}, NOW);
  const good = answerCard(card, 3, {}, NOW);
  const easy = answerCard(card, 4, {}, NOW);
  assert.ok(hard.ivl >= 11 && hard.ivl <= 13, `hard ${hard.ivl}`);
  assert.ok(good.ivl >= 23 && good.ivl <= 27, `good ${good.ivl}`);
  assert.ok(easy.ivl > good.ivl && good.ivl > hard.ivl);
  assert.equal(hard.ease, 2350);
  assert.equal(good.ease, 2500);
  assert.equal(easy.ease, 2650);
  assert.equal(dayNumber(good.due), today + good.ivl);
});

test('forgetting a review card sends it to relearning and back', () => {
  const card = { id: 9, state: 'review', due: dayStart(today), ivl: 20, ease: 2500, reps: 5, lapses: 0, step: 0 };
  const lapse = answerCard(card, 1, {}, NOW);
  assert.equal(lapse.state, 'relearning');
  assert.equal(lapse.lapses, 1);
  assert.equal(lapse.ease, 2300);
  assert.equal(lapse.ivl, 1);
  assert.equal(lapse.due, NOW + 10 * MIN);
  const back = answerCard(lapse, 3, {}, NOW + 10 * MIN);
  assert.equal(back.state, 'review');
  assert.equal(back.ivl, 1);
});

test('deadline caps intervals at half the remaining time', () => {
  const review = { id: 3, state: 'review', due: dayStart(today), ivl: 10, ease: 2500, reps: 4, lapses: 0, step: 0 };
  // Deadline in 5 hours: "Gut" would normally mean ~25 days, now it is 2.5 hours.
  const cfg = { deadline: NOW + 5 * 3_600_000 };
  const good = answerCard(review, 3, cfg, NOW);
  assert.equal(good.capped, true);
  assert.equal(good.due, NOW + 2.5 * 3_600_000);
  assert.ok(good.ivl >= 23, 'the long-term interval is kept for after the deadline');
  assert.equal(previewIntervals(review, cfg, NOW)[3], '2,5 Std');

  // Deadline in 6 days: the gap of a new "Einfach" card (4 days) shrinks to 3 days, starting at the day boundary.
  const easy = answerCard(newCard, 4, { deadline: NOW + 6 * DAY }, NOW);
  assert.equal(easy.due, dayStart(today + 3));
  // 30 hours of slack at 18:00 means "tomorrow" (4:00, i.e. in 10 hours).
  const tomorrow = answerCard(newCard, 4, { deadline: NOW + 61 * 3_600_000 }, NOW);
  assert.equal(tomorrow.due, dayStart(today + 1));
  assert.equal(previewIntervals(newCard, { deadline: NOW + 61 * 3_600_000 }, NOW)[4], '10 Std');

  // Short learning steps stay untouched, and without a (future) deadline nothing changes.
  assert.equal(answerCard(newCard, 1, cfg, NOW).due, NOW + MIN);
  assert.equal(answerCard(review, 3, { deadline: NOW - 1000 }, NOW).capped, undefined);
});

test('with a deadline the buttons show real waiting times in order (Gut before Einfach)', () => {
  // Situation from the phone screenshot: 19:05, learning card on its last step, deadline in 37 hours.
  const at = new Date(2026, 10, 15, 19, 5).getTime();
  const cfg = { deadline: at + 37 * 3_600_000 };
  const learning = { id: 8, state: 'learning', due: at, ivl: 0, ease: 2500, reps: 1, lapses: 0, step: 1 };
  const p = previewIntervals(learning, cfg, at);
  assert.equal(p[3], '9 Std', 'Gut: next day at 4:00 → real wait instead of "1 T"');
  assert.equal(p[4], '18,5 Std', 'Einfach: half the remaining time');
  const due = [1, 2, 3, 4].map((r) => answerCard(learning, r, cfg, at).due);
  for (let i = 1; i < 4; i++) assert.ok(due[i] >= due[i - 1], `rating ${i + 1} is not earlier than rating ${i}`);
});

test('near the deadline the gap never drops below 10 minutes until the end', () => {
  const review = { id: 4, state: 'review', due: dayStart(today), ivl: 3, ease: 2500, reps: 2, lapses: 0, step: 0 };
  assert.equal(answerCard(review, 3, { deadline: NOW + 15 * MIN }, NOW).due, NOW + 10 * MIN);
  assert.equal(answerCard(review, 3, { deadline: NOW + 4 * MIN }, NOW).due, NOW + 4 * MIN);
});

test('previews match the real answer and are formatted in German', () => {
  const p = previewIntervals(newCard, {}, NOW);
  assert.deepEqual([p[1], p[2], p[3]], ['1 Min', '6 Min', '10 Min']);
  assert.match(p[4], /^\d T$/);
  assert.equal(formatInterval(90 * DAY), '3 Mon');
  assert.equal(formatInterval(400 * DAY), '1,1 J');
});

test('reviewing ahead bases the interval on the elapsed days but never shortens it', () => {
  // Interval 10 days, due in 6 days → 4 days have passed.
  const card = { id: 11, state: 'review', due: dayStart(today + 6), ivl: 10, ease: 2500, reps: 5, lapses: 0, step: 0 };
  const hard = answerCard(card, 2, {}, NOW);
  const good = answerCard(card, 3, {}, NOW);
  const easy = answerCard(card, 4, {}, NOW);
  assert.ok(good.ivl >= 10 && good.ivl <= 11, `good ${good.ivl} (≈ planned interval, not 25)`);
  assert.ok(hard.ivl >= 5 && hard.ivl <= good.ivl, `hard ${hard.ivl}`);
  assert.ok(easy.ivl > good.ivl, `easy ${easy.ivl}`);
  assert.ok(good.due >= card.due, 'never earlier than planned');
  // A card that was almost due is treated nearly like a normal review.
  const almost = answerCard({ ...card, due: dayStart(today + 1) }, 3, {}, NOW);
  assert.ok(almost.ivl >= 20, `almost due: ${almost.ivl}`);
});
