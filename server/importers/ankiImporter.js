import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { DAY, DEFAULT_CONFIG, dayNumber, dayStart } from '../scheduler.js';
import { protoFloats, protoMessage, protoNumber, protoString, readProto } from './protoReader.js';
import { clozeToSides, htmlToText, labelConfig } from './textUtils.js';
import { readZip } from './zipReader.js';

const SPECIAL_FIELDS = new Set(['FrontSide', 'Tags', 'Deck', 'Subdeck', 'Card', 'CardFlag', 'Type']);

/** Parse an .apkg / .colpkg (ZIP) file. */
export function parseAnkiPackage(buf) {
  const zip = readZip(buf);
  let collection;
  if (zip.has('collection.anki21b')) collection = zlib.zstdDecompressSync(zip.read('collection.anki21b'));
  else if (zip.has('collection.anki21')) collection = zip.read('collection.anki21');
  else if (zip.has('collection.anki2')) collection = zip.read('collection.anki2');
  else throw new Error('In der Datei wurde keine Anki-Sammlung gefunden.');
  return parseCollectionBuffer(collection);
}

/** Parse a raw collection database (SQLite bytes). */
export function parseCollectionBuffer(buf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anki-rea-'));
  try {
    const file = path.join(dir, 'collection.anki2');
    fs.writeFileSync(file, buf);
    return parseCollectionFile(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Parse an Anki collection file. The file is modified (collation rewrite),
 * so always pass a private copy – never the live collection.
 */
export function parseCollectionFile(file) {
  // Anki declares a custom "unicase" collation that SQLite outside Anki does not know.
  // Stripping it from the schema of our private copy makes the tables readable.
  const rw = new DatabaseSync(file);
  try {
    rw.enableDefensive?.(false);
    rw.exec('PRAGMA writable_schema = ON');
    rw.exec("UPDATE sqlite_schema SET sql = replace(sql, 'COLLATE unicase', '') WHERE sql LIKE '%COLLATE unicase%'");
    rw.exec('PRAGMA writable_schema = OFF');
  } finally {
    rw.close();
  }
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return readCollection(db);
  } finally {
    db.close();
  }
}

function blob(v) {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

function configFromProto(buf) {
  const f = readProto(blob(buf));
  const cfg = {};
  const set = (key, value, map = (x) => x) => {
    if (value !== undefined) cfg[key] = map(value);
  };
  set('learnSteps', protoFloats(f[1]));
  set('relearnSteps', protoFloats(f[2]));
  set('newPerDay', protoNumber(f[9]));
  set('reviewsPerDay', protoNumber(f[10]));
  set('startingEase', protoNumber(f[11]), (v) => Math.round(v * 1000));
  set('easyBonus', protoNumber(f[12]), (v) => Math.round(v * 1000) / 1000);
  set('hardFactor', protoNumber(f[13]), (v) => Math.round(v * 1000) / 1000);
  set('lapseIvlFactor', protoNumber(f[14]), (v) => Math.round(v * 1000) / 1000);
  set('ivlModifier', protoNumber(f[15]), (v) => Math.round(v * 1000) / 1000);
  set('maxIvl', protoNumber(f[16]));
  set('minLapseIvl', protoNumber(f[17]));
  set('graduatingIvl', protoNumber(f[18]));
  set('easyIvl', protoNumber(f[19]));
  return cfg;
}

function configFromLegacy(c) {
  const cfg = {};
  if (Array.isArray(c?.new?.delays)) cfg.learnSteps = c.new.delays;
  if (Array.isArray(c?.lapse?.delays)) cfg.relearnSteps = c.lapse.delays;
  if (c?.new?.perDay !== undefined) cfg.newPerDay = c.new.perDay;
  if (c?.rev?.perDay !== undefined) cfg.reviewsPerDay = c.rev.perDay;
  if (c?.new?.initialFactor) cfg.startingEase = c.new.initialFactor;
  if (c?.new?.ints?.[0]) cfg.graduatingIvl = c.new.ints[0];
  if (c?.new?.ints?.[1]) cfg.easyIvl = c.new.ints[1];
  if (c?.rev?.ease4) cfg.easyBonus = c.rev.ease4;
  if (c?.rev?.hardFactor) cfg.hardFactor = c.rev.hardFactor;
  if (c?.rev?.ivlFct) cfg.ivlModifier = c.rev.ivlFct;
  if (c?.rev?.maxIvl) cfg.maxIvl = c.rev.maxIvl;
  if (c?.lapse?.minInt) cfg.minLapseIvl = c.lapse.minInt;
  if (c?.lapse?.mult !== undefined) cfg.lapseIvlFactor = c.lapse.mult;
  return cfg;
}

function fieldRefs(template, names) {
  return [...String(template || '').matchAll(/\{\{([^}]+)\}\}/g)]
    .map((m) => m[1].trim())
    .filter((ref) => !/^[#/^!]/.test(ref))
    .map((ref) => ref.split(':').pop().trim())
    .filter((ref) => !SPECIAL_FIELDS.has(ref) && names.includes(ref));
}

/** Decide which Anki field becomes front / back / extra, using the first card template. */
function fieldPlan(model) {
  const names = model.fields;
  const q = fieldRefs(model.qfmt, names);
  const a = fieldRefs(model.afmt, names).filter((x) => !q.includes(x));
  const frontIdx = q.length ? names.indexOf(q[0]) : 0;
  let backIdx = a.length ? names.indexOf(a[0]) : -1;
  if (backIdx < 0) backIdx = names.findIndex((_, i) => i !== frontIdx);
  let extraIdx = a.slice(1).map((x) => names.indexOf(x));
  if (!model.qfmt && !model.afmt) extraIdx = names.map((_, i) => i).filter((i) => i !== frontIdx && i !== backIdx);
  return { frontIdx, backIdx, extraIdx };
}

function loadModern(db) {
  const models = new Map();
  for (const nt of db.prepare('SELECT id, name, config FROM notetypes').all()) {
    const cfg = nt.config ? readProto(blob(nt.config)) : {};
    models.set(nt.id, { name: nt.name, cloze: protoNumber(cfg[1]) === 1, fields: [], qfmt: '', afmt: '', templates: 0 });
  }
  for (const f of db.prepare('SELECT ntid, ord, name FROM fields ORDER BY ntid, ord').all()) models.get(f.ntid)?.fields.push(f.name);
  for (const t of db.prepare('SELECT ntid, ord, config FROM templates ORDER BY ntid, ord').all()) {
    const m = models.get(t.ntid);
    if (!m) continue;
    m.templates++;
    if (t.ord === 0) {
      const tf = readProto(blob(t.config));
      m.qfmt = protoString(tf[1]) || '';
      m.afmt = protoString(tf[2]) || '';
    }
  }
  const confs = new Map();
  for (const c of db.prepare('SELECT id, config FROM deck_config').all()) confs.set(c.id, configFromProto(c.config));
  const decks = new Map();
  for (const d of db.prepare('SELECT id, name, kind FROM decks').all()) {
    const normal = protoMessage(readProto(blob(d.kind))[1]);
    decks.set(d.id, { name: d.name, conf: confs.get(normal ? protoNumber(normal[1]) ?? 1 : 1) || {} });
  }
  return { models, decks };
}

function loadLegacy(db) {
  const col = db.prepare('SELECT models, decks, dconf FROM col').get();
  const models = new Map();
  for (const [id, m] of Object.entries(JSON.parse(col.models || '{}'))) {
    const fields = [...(m.flds || [])].sort((a, b) => a.ord - b.ord).map((f) => f.name);
    const t0 = (m.tmpls || []).find((t) => t.ord === 0) || {};
    models.set(Number(id), { name: m.name, cloze: m.type === 1, fields, qfmt: t0.qfmt || '', afmt: t0.afmt || '', templates: (m.tmpls || []).length });
  }
  const dconf = JSON.parse(col.dconf || '{}');
  const decks = new Map();
  for (const [id, d] of Object.entries(JSON.parse(col.decks || '{}'))) {
    decks.set(Number(id), { name: d.name, conf: configFromLegacy(dconf[d.conf] || dconf[1]) });
  }
  return { models, decks };
}

function convertCard(c, crtDay, cfg, rollover) {
  const out = {
    ord: c.ord,
    state: 'new',
    due: 0,
    ivl: Math.max(0, c.ivl),
    ease: c.factor || cfg.startingEase || DEFAULT_CONFIG.startingEase,
    reps: c.reps,
    lapses: c.lapses,
    step: 0,
    position: 0,
    suspended: c.queue === -1,
  };
  const due = c.odid ? c.odue || c.due : c.due;
  const toTime = (v) => (v > 1e8 ? v * 1000 : dayStart(crtDay + v, rollover));
  if (c.type === 0) {
    out.position = due;
    out.reps = 0;
  } else if (c.type === 1 || c.type === 3) {
    const steps = (c.type === 1 ? cfg.learnSteps : cfg.relearnSteps) || [];
    out.state = c.type === 1 ? 'learning' : 'relearning';
    out.step = Math.min(Math.max(0, steps.length - 1), Math.max(0, steps.length - (c.left % 1000)));
    out.due = toTime(due);
  } else if (c.type === 2) {
    out.state = 'review';
    out.ivl = Math.max(1, c.ivl);
    out.due = toTime(due);
  }
  return out;
}

function readCollection(db) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((r) => r.name));
  const col = db.prepare('SELECT crt FROM col').get();
  const rollover = DEFAULT_CONFIG.rolloverHour;
  const crtDay = dayNumber(col.crt * 1000 + DAY / 2, rollover);
  const { models, decks } = tables.has('notetypes') ? loadModern(db) : loadLegacy(db);

  const cards = db.prepare('SELECT id, nid, did, ord, type, queue, due, ivl, factor, reps, lapses, left, odue, odid FROM cards').all();
  const revlog = db.prepare('SELECT id, cid, ease, ivl, factor, time, type FROM revlog ORDER BY id').all();
  const revByCard = new Map();
  for (const r of revlog) {
    if (!(r.ease >= 1 && r.ease <= 4) || r.type > 3) continue;
    const list = revByCard.get(r.cid) || [];
    const prevState = r.type === 0 ? (list.length ? 'learning' : 'new') : r.type === 2 ? 'relearning' : 'review';
    list.push({ ts: r.id, rating: r.ease, prevState, ivl: r.ivl > 0 ? r.ivl : 0, ease: r.factor, timeMs: r.time });
    revByCard.set(r.cid, list);
  }
  const cardsByNote = new Map();
  for (const c of cards) {
    const list = cardsByNote.get(c.nid) || [];
    list.push(c);
    cardsByNote.set(c.nid, list);
  }

  const outDecks = new Map();
  const warnings = new Set();
  let skipped = 0;
  for (const note of db.prepare('SELECT id, guid, mid, flds, tags FROM notes ORDER BY id').all()) {
    const model = models.get(note.mid);
    const noteCards = (cardsByNote.get(note.id) || []).sort((a, b) => a.ord - b.ord);
    if (!model || !noteCards.length) {
      skipped++;
      continue;
    }
    const fields = note.flds.split('\x1f');
    if (/<img/i.test(note.flds)) warnings.add('Bilder werden nicht übernommen – nur der Text der Karten.');
    let front;
    let back;
    let extra;
    if (model.cloze || /\{\{c\d+::/.test(fields[0] || '')) {
      const sides = clozeToSides(htmlToText(fields[0]));
      front = sides.front;
      back = sides.back;
      extra = fields.slice(1).map(htmlToText).filter(Boolean).join('\n');
    } else {
      const plan = fieldPlan(model);
      front = htmlToText(fields[plan.frontIdx]);
      back = htmlToText(fields[plan.backIdx]);
      extra = plan.extraIdx.map((i) => htmlToText(fields[i])).filter(Boolean).join('\n');
    }
    if (!front || !back) {
      skipped++;
      continue;
    }
    const first = noteCards[0];
    const deckId = first.odid || first.did;
    const deck = decks.get(deckId) || { name: 'Importiert', conf: {} };
    if (!outDecks.has(deckId)) {
      const plan = model.cloze ? null : fieldPlan(model);
      outDecks.set(deckId, {
        name: deck.name.split('\x1f').join(' › ').replace(/::/g, ' › '),
        config: {
          ...deck.conf,
          ...(plan
            ? labelConfig(model.fields[plan.frontIdx], model.fields[plan.backIdx], plan.extraIdx.length === 1 ? model.fields[plan.extraIdx[0]] : '')
            : {}),
        },
        notes: [],
      });
    }
    const outDeck = outDecks.get(deckId);
    const deckCfg = { ...DEFAULT_CONFIG, ...deck.conf };
    const converted = noteCards
      .filter((c) => c.ord <= 1 && !model.cloze)
      .map((c) => ({ ...convertCard(c, crtDay, deckCfg, rollover), reviews: revByCard.get(c.id) || [] }));
    if (model.cloze) converted.push({ ...convertCard({ ...first, ord: 0 }, crtDay, deckCfg, rollover), reviews: revByCard.get(first.id) || [] });
    if (converted.some((c) => c.ord === 1)) outDeck.config.bothDirections = true;
    outDeck.notes.push({
      front,
      back,
      extra,
      tags: note.tags.trim(),
      sourceId: `anki:${note.guid}`,
      cards: converted,
    });
  }
  if (skipped) warnings.add(`${skipped} Notiz(en) ohne lesbaren Text wurden übersprungen.`);
  return {
    format: 'anki',
    formatLabel: 'Anki-Sammlung',
    hasProgress: true,
    decks: [...outDecks.values()].filter((d) => d.notes.length),
    warnings: [...warnings],
  };
}
