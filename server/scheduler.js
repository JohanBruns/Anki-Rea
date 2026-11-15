// SM-2 scheduler modelled on Anki's v3 scheduler (without FSRS).
// Behaviour was taken from the user's installed Anki 26.9 collection:
// learning steps 1m/10m, relearning 10m, starting ease 250 %, easy bonus 1.3,
// hard factor 1.2, max interval 36500 days, day rollover at 4:00.

export const MIN = 60_000;
export const DAY = 86_400_000;

export const DEFAULT_CONFIG = {
  newPerDay: 20,
  reviewsPerDay: 200,
  learnSteps: [1, 10], // minutes
  relearnSteps: [10], // minutes
  graduatingIvl: 1, // days
  easyIvl: 4, // days
  startingEase: 2500, // permille
  easyBonus: 1.3,
  hardFactor: 1.2,
  ivlModifier: 1.0,
  lapseIvlFactor: 0,
  minLapseIvl: 1,
  maxIvl: 36500,
  learnAheadMin: 20,
  rolloverHour: 4,
  bothDirections: false,
  deadline: null, // timestamp (ms) by which every card must be known; null = no deadline
  // display
  frontLabel: 'Vorderseite',
  backLabel: 'Rückseite',
  extraLabel: 'Beispiel',
  frontLang: '',
  backLang: '',
  autoplay: false,
};

export function withDefaults(cfg) {
  return { ...DEFAULT_CONFIG, ...(cfg || {}) };
}

/** Day index (days since epoch) of a timestamp, respecting the local rollover hour. */
export function dayNumber(ms, rolloverHour = DEFAULT_CONFIG.rolloverHour) {
  const d = new Date(ms - rolloverHour * 3_600_000);
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY);
}

/** Local timestamp at which the given day index starts (at the rollover hour). */
export function dayStart(day, rolloverHour = DEFAULT_CONFIG.rolloverHour) {
  const u = new Date(day * DAY);
  return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(), rolloverHour).getTime();
}

function seededRandom(seed) {
  let h = (Math.floor(seed) ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4_294_967_296;
}

/** Anki-style interval fuzz, deterministic per card + rep so previews match the real answer. */
function fuzz(ivl, seed) {
  if (ivl < 2.5) return ivl;
  let range;
  if (ivl < 7) range = Math.max(1, Math.round(ivl * 0.15));
  else if (ivl < 20) range = Math.max(1, Math.round(ivl * 0.1));
  else range = Math.max(1, Math.round(ivl * 0.05));
  return ivl + Math.round((seededRandom(seed) * 2 - 1) * range);
}

function constrain(ivl, minimum, cfg, seed) {
  const fuzzed = fuzz(Math.round(ivl), seed);
  return Math.min(cfg.maxIvl, Math.max(1, minimum, fuzzed));
}

function hardDelay(steps, step) {
  if (step === 0) {
    if (steps.length >= 2) return (steps[0] + steps[1]) / 2;
    return Math.min(steps[0] * 1.5, steps[0] + 1440);
  }
  return steps[step];
}

function graduate(c, cfg, today, { easy, relearn, seed }) {
  let ivl;
  if (relearn) ivl = Math.max(1, c.ivl) + (easy ? 1 : 0);
  else ivl = constrain(easy ? cfg.easyIvl : cfg.graduatingIvl, 1, cfg, seed);
  return {
    ...c,
    state: 'review',
    ivl,
    step: 0,
    ease: relearn ? c.ease : c.ease || cfg.startingEase,
    due: dayStart(today + ivl, cfg.rolloverHour),
  };
}

function answerLearning(c, rating, steps, cfg, now, today, relearn, seed) {
  if (!steps.length) return graduate(c, cfg, today, { easy: rating === 4, relearn, seed });
  const step = c.state === 'new' ? 0 : Math.min(c.step, steps.length - 1);
  const learning = (s, delay) => ({
    ...c,
    state: relearn ? 'relearning' : 'learning',
    step: s,
    ease: c.ease || cfg.startingEase,
    due: now + Math.round(delay * MIN),
  });
  switch (rating) {
    case 1:
      return learning(0, steps[0]);
    case 2:
      return learning(step, hardDelay(steps, step));
    case 3:
      if (step + 1 >= steps.length) return graduate(c, cfg, today, { easy: false, relearn, seed });
      return learning(step + 1, steps[step + 1]);
    default:
      return graduate(c, cfg, today, { easy: true, relearn, seed });
  }
}

function answerReview(c, rating, cfg, now, today, seed) {
  const daysLate = Math.max(0, today - dayNumber(c.due, cfg.rolloverHour));
  const ivl = Math.max(1, c.ivl);
  const ease = (c.ease || cfg.startingEase) / 1000;

  if (rating === 1) {
    const lapsed = {
      ...c,
      lapses: c.lapses + 1,
      ease: Math.max(1300, c.ease - 200),
      ivl: Math.max(cfg.minLapseIvl, Math.round(ivl * cfg.lapseIvlFactor)),
    };
    if (cfg.relearnSteps.length) {
      return { ...lapsed, state: 'relearning', step: 0, due: now + Math.round(cfg.relearnSteps[0] * MIN) };
    }
    return { ...lapsed, state: 'review', step: 0, due: dayStart(today + lapsed.ivl, cfg.rolloverHour) };
  }

  const daysEarly = dayNumber(c.due, cfg.rolloverHour) - today;
  let hard, good, easy;
  if (daysEarly > 0) {
    // Studied ahead ("Weiterlernen"): like Anki's early review, the interval is based on the days that
    // actually passed, but never shorter than the planned one – reviewing early must not hurt.
    const elapsed = Math.max(0, ivl - daysEarly);
    const easyBonus = 1 - (1 - cfg.easyBonus) / 2; // half the easy bonus
    hard = constrain(Math.max(elapsed * cfg.hardFactor, ivl * cfg.hardFactor * 0.5) * cfg.ivlModifier, 1, cfg, seed);
    good = constrain(Math.max(elapsed * ease, ivl) * cfg.ivlModifier, Math.max(hard, ivl), cfg, seed + 1);
    easy = constrain(Math.max(elapsed * ease, ivl) * easyBonus * cfg.ivlModifier, good + 1, cfg, seed + 2);
  } else {
    const hardMin = cfg.hardFactor > 1 ? ivl + 1 : 1;
    hard = constrain(ivl * cfg.hardFactor * cfg.ivlModifier, hardMin, cfg, seed);
    good = constrain((ivl + daysLate / 2) * ease * cfg.ivlModifier, hard + 1, cfg, seed + 1);
    easy = constrain((ivl + daysLate) * ease * cfg.easyBonus * cfg.ivlModifier, good + 1, cfg, seed + 2);
  }

  let newIvl = good;
  let newEase = c.ease;
  if (rating === 2) {
    newIvl = hard;
    newEase = Math.max(1300, c.ease - 150);
  } else if (rating === 4) {
    newIvl = easy;
    newEase = c.ease + 150;
  }
  return { ...c, state: 'review', step: 0, ivl: newIvl, ease: newEase, due: dayStart(today + newIvl, cfg.rolloverHour) };
}

export const isDeadlineActive = (cfg, now = Date.now()) => Number(cfg?.deadline) > now;

/**
 * Deadline mode: the next review may be at most half of the remaining time away, so every card
 * comes back several times before the deadline and the gaps shrink towards it (2 days → 1 day → hours).
 * The normal interval (ivl) is kept, so long-term spacing continues once the deadline has passed.
 */
export function applyDeadline(next, cfg, now) {
  if (!isDeadlineActive(cfg, now)) return next;
  const remaining = cfg.deadline - now;
  const cap = Math.max(Math.min(remaining, 10 * MIN), remaining * 0.5);
  if (next.due - now <= cap) return next;
  if (cap >= DAY) {
    // Gaps of a day or more are counted in whole days and start at the day boundary, like normal reviews.
    const days = Math.floor(cap / DAY);
    return { ...next, due: dayStart(dayNumber(now, cfg.rolloverHour) + days, cfg.rolloverHour), capped: true };
  }
  return { ...next, due: Math.round(now + cap), capped: true };
}

/**
 * Apply a rating (1 = Nochmal, 2 = Schwer, 3 = Gut, 4 = Einfach) to a card.
 * card: { id, state, due, ivl, ease, reps, lapses, step }
 */
export function answerCard(card, rating, cfgIn, now = Date.now()) {
  if (![1, 2, 3, 4].includes(rating)) throw new Error(`Ungültige Bewertung: ${rating}`);
  const cfg = withDefaults(cfgIn);
  const today = dayNumber(now, cfg.rolloverHour);
  const seed = (card.id || 0) * 7 + (card.reps || 0) * 131;
  const c = { ...card, reps: (card.reps || 0) + 1, lapses: card.lapses || 0, ease: card.ease || cfg.startingEase };
  let next;
  switch (card.state) {
    case 'review':
      next = answerReview(c, rating, cfg, now, today, seed);
      break;
    case 'relearning':
      next = answerLearning(c, rating, cfg.relearnSteps, cfg, now, today, true, seed);
      break;
    default:
      next = answerLearning(c, rating, cfg.learnSteps, cfg, now, today, false, seed);
  }
  return applyDeadline(next, cfg, now);
}

export function formatInterval(ms) {
  const fmt = (n) => n.toLocaleString('de-DE', { maximumFractionDigits: 1 });
  const mins = ms / MIN;
  if (mins < 1) return '<1 Min';
  if (mins < 60) return `${Math.round(mins)} Min`;
  const hours = mins / 60;
  if (hours < 24) return `${fmt(Math.round(hours * 2) / 2)} Std`; // half hours: "9 Std", "18,5 Std"
  const days = Math.round(hours / 24);
  if (days < 31) return `${days} T`;
  if (days < 365) return `${fmt(Math.round((days / 30) * 10) / 10)} Mon`;
  return `${fmt(Math.round((days / 365) * 10) / 10)} J`;
}

/** Human-readable next interval for each rating, as shown on the answer buttons. */
export function previewIntervals(card, cfgIn, now = Date.now()) {
  const cfg = withDefaults(cfgIn);
  // With a deadline, every button shows the real waiting time. Mixing "1 T" (next day, i.e. 4:00 tomorrow)
  // with exact hours ("18,5 Std") would make the later option look earlier.
  const exact = isDeadlineActive(cfg, now);
  const out = {};
  for (const rating of [1, 2, 3, 4]) {
    const next = answerCard(card, rating, cfg, now);
    out[rating] = next.state === 'review' && !exact ? formatInterval(next.ivl * DAY) : formatInterval(next.due - now);
  }
  return out;
}
