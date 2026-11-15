import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openDatabase } from '../server/db.js';
import { parseUpload } from '../server/importers/index.js';
import { applyImport } from '../server/importService.js';

const txt = (s) => Buffer.from(s, 'utf8');

test('tab separated list with header row', () => {
  const r = parseUpload(txt('Deutsch\tSpanisch\tBeispiel\nbetteln\tmendigar\tLos niños mendigan.\nverkaufen\tvender\t\n'), 'Niños.txt');
  assert.equal(r.decks.length, 1);
  assert.equal(r.decks[0].name, 'Niños');
  assert.equal(r.decks[0].config.frontLabel, 'Deutsch');
  assert.equal(r.decks[0].config.backLang, 'es-ES');
  assert.deepEqual(
    r.decks[0].notes.map((n) => [n.front, n.back, n.extra]),
    [
      ['betteln', 'mendigar', 'Los niños mendigan.'],
      ['verkaufen', 'vender', ''],
    ],
  );
});

test('semicolon CSV with quotes and a Windows-1252 fallback', () => {
  const latin1 = Buffer.from('"schätzen";"estimar; valorar"\r\nmerkwürdig;raro\r\n', 'latin1');
  const r = parseUpload(latin1, 'liste.csv');
  assert.deepEqual(
    r.decks[0].notes.map((n) => [n.front, n.back]),
    [
      ['schätzen', 'estimar; valorar'],
      ['merkwürdig', 'raro'],
    ],
  );
});

test('"Wort - Übersetzung" lines', () => {
  const r = parseUpload(txt('die Mehrheit - la mayoría\neine Beziehung, Verbindung - una relación\n\n(Zeit) verbringen - pasar (el tiempo)'), 'x.txt');
  assert.deepEqual(
    r.decks[0].notes.map((n) => [n.front, n.back]),
    [
      ['die Mehrheit', 'la mayoría'],
      ['eine Beziehung, Verbindung', 'una relación'],
      ['(Zeit) verbringen', 'pasar (el tiempo)'],
    ],
  );
});

test('Anki "Notizen als Text" export with metadata columns', () => {
  const file = '#separator:tab\n#html:true\n#guid column:1\n#notetype column:2\n#deck column:3\n#tags column:6\nabc\tVokabel\tSpanisch::Kapitel 1\tdie <b>Mehrheit</b>\tla mayoría\tkap1\n';
  const r = parseUpload(txt(file), 'export.txt');
  const d = r.decks[0];
  assert.equal(d.name, 'Spanisch › Kapitel 1');
  assert.deepEqual(d.notes[0], { front: 'die Mehrheit', back: 'la mayoría', extra: '', tags: 'kap1', sourceId: 'anki:abc' });
});

test('JSON list of objects', () => {
  const r = parseUpload(txt(JSON.stringify([{ front: 'betteln', back: 'mendigar' }, ['verkaufen', 'vender', 'Venden cosas.']])), 'a.json');
  assert.equal(r.decks[0].notes.length, 2);
  assert.equal(r.decks[0].notes[1].extra, 'Venden cosas.');
});

// --- minimal ZIP writer for building test packages ---
function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const deflated = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, deflated);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(deflated.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + deflated.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}

function legacyCollection() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anki-rea-test-'));
  const file = path.join(dir, 'c.anki2');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE col (id integer primary key, crt integer, models text, decks text, dconf text);
    CREATE TABLE notes (id integer primary key, guid text, mid integer, flds text, tags text);
    CREATE TABLE cards (id integer primary key, nid integer, did integer, ord integer, type integer, queue integer, due integer,
      ivl integer, factor integer, reps integer, lapses integer, left integer, odue integer, odid integer);
    CREATE TABLE revlog (id integer primary key, cid integer, ease integer, ivl integer, factor integer, time integer, type integer);`);
  const crt = Math.floor(new Date(2026, 10, 1, 4).getTime() / 1000);
  const models = { 5: { name: 'Basic', type: 0, flds: [{ name: 'Front', ord: 0 }, { name: 'Back', ord: 1 }], tmpls: [{ ord: 0, qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr>{{Back}}' }] } };
  const decks = { 1: { name: 'Default', conf: 1 }, 9: { name: 'Spanisch::Verben', conf: 1 } };
  const dconf = { 1: { new: { delays: [1, 10], ints: [1, 4], initialFactor: 2500, perDay: 15 }, rev: { perDay: 100 }, lapse: { delays: [10] } } };
  db.prepare('INSERT INTO col VALUES (1, ?, ?, ?, ?)').run(crt, JSON.stringify(models), JSON.stringify(decks), JSON.stringify(dconf));
  db.prepare('INSERT INTO notes VALUES (?, ?, 5, ?, ?)').run(100, 'g1', 'betteln\x1fmendigar', ' verben ');
  db.prepare('INSERT INTO notes VALUES (?, ?, 5, ?, ?)').run(101, 'g2', 'verkaufen&nbsp;<br>(etw.)\x1f<i>vender</i>', '');
  db.prepare('INSERT INTO cards VALUES (200, 100, 9, 0, 2, 2, 20, 6, 2300, 4, 1, 0, 0, 0)').run();
  db.prepare('INSERT INTO cards VALUES (201, 101, 9, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0)').run();
  db.prepare('INSERT INTO revlog VALUES (?, 200, 3, 6, 2300, 5000, 1)').run(Date.now() - 86_400_000);
  db.close();
  const buf = fs.readFileSync(file);
  fs.rmSync(dir, { recursive: true, force: true });
  return { buf, crt };
}

test('legacy .apkg package keeps decks, text and progress', () => {
  const { buf } = legacyCollection();
  const r = parseUpload(zip({ 'collection.anki2': buf, media: Buffer.from('{}') }), 'spanisch.apkg');
  assert.equal(r.format, 'anki');
  assert.equal(r.decks.length, 1);
  const d = r.decks[0];
  assert.equal(d.name, 'Spanisch › Verben');
  assert.equal(d.config.newPerDay, 15);
  const [a, b] = d.notes;
  assert.equal(a.front, 'betteln');
  assert.equal(a.cards[0].state, 'review');
  assert.equal(a.cards[0].ivl, 6);
  assert.equal(a.cards[0].ease, 2300);
  assert.equal(new Date(a.cards[0].due).getDate(), 21, 'due day 20 after Nov 1st');
  assert.equal(a.cards[0].reviews.length, 1);
  assert.equal(b.front, 'verkaufen\n(etw.)');
  assert.equal(b.back, 'vender');
  assert.equal(b.cards[0].state, 'new');
});

const count = async (db, sql, ...args) => Number((await db.get(sql, ...args)).n);

test('applyImport stores notes and skips duplicates on re-import', async () => {
  const db = await openDatabase(':memory:');
  const parsed = parseUpload(txt('betteln\tmendigar\nverkaufen\tvender\n'), 'Spanisch.txt');
  const first = await applyImport(db, parsed);
  assert.equal(first.added, 2);
  const again = await applyImport(db, parseUpload(txt('betteln\tmendigar\nlustrar\tputzen\n'), 'Spanisch.txt'));
  assert.equal(again.added, 1);
  assert.equal(again.skipped, 1);
  assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM notes'), 3);
  assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM cards'), 6, 'forward + reverse card per note');
  assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM decks'), 1);
});

test('applyImport with progress keeps Anki scheduling', async () => {
  const db = await openDatabase(':memory:');
  const { buf } = legacyCollection();
  const parsed = parseUpload(zip({ 'collection.anki2': buf }), 'x.apkg');
  await applyImport(db, parsed, { progress: true });
  const card = await db.get("SELECT c.* FROM cards c JOIN notes n ON n.id = c.note_id WHERE n.front = 'betteln' AND c.ord = 0");
  assert.equal(card.state, 'review');
  assert.equal(card.ivl, 6);
  assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM reviews'), 1);
  // Re-importing the same package must not duplicate anything.
  const again = await applyImport(db, parseUpload(zip({ 'collection.anki2': legacyCollection().buf }), 'x.apkg'), { progress: true });
  assert.equal(again.added, 0);
  assert.equal(again.skipped, 2);
});
