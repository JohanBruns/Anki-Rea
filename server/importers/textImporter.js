import { deckNameFromFile, htmlToText, labelConfig } from './textUtils.js';

const HEADER_ALIASES = {
  front: ['front', 'vorderseite', 'frage', 'question', 'wort', 'word', 'begriff', 'term', 'deutsch', 'german'],
  back: ['back', 'rückseite', 'rueckseite', 'antwort', 'answer', 'übersetzung', 'uebersetzung', 'translation', 'bedeutung', 'meaning'],
  extra: ['extra', 'beispiel', 'example', 'beispielsatz', 'notiz', 'notes', 'note', 'kommentar', 'satz'],
  tags: ['tags', 'tag', 'schlagwörter', 'schlagworte'],
};
const KNOWN_LANG_HEADERS = /^(deutsch|german|spanisch|spanish|español|englisch|english|französisch|french|italienisch|italian|portugiesisch|portuguese|niederländisch|dutch|schwedisch|polnisch|russisch|türkisch|japanisch|chinesisch|latein)$/i;

/** Decode bytes as UTF-8, falling back to Windows-1252 for old Excel/Notepad exports. */
export function decodeText(buf) {
  let bytes = buf;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

const QUOTED = new Set(['\t', ';', ',', '|']);
const SEPARATOR_CANDIDATES = ['\t', ';', '|', ' = ', ' – ', ' — ', ' - ', ',', ': '];
const NAMED_SEPARATORS = { tab: '\t', comma: ',', semicolon: ';', pipe: '|', space: ' ', colon: ':' };

function parseDelimited(text, sep) {
  const rows = [];
  if (!QUOTED.has(sep)) {
    for (const line of text.split('\n')) rows.push(line.split(sep));
    return rows;
  }
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell.trim() === '') {
      quoted = true;
      cell = '';
    } else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

function detectSeparator(lines) {
  const sample = lines.filter((l) => l.trim()).slice(0, 100);
  if (!sample.length) return '\t';
  for (const sep of SEPARATOR_CANDIDATES) {
    const hits = sample.filter((l) => l.includes(sep)).length;
    if (hits / sample.length >= 0.8) return sep;
  }
  return '\t';
}

function headerRole(cell) {
  const v = String(cell || '').trim().toLowerCase();
  for (const [role, names] of Object.entries(HEADER_ALIASES)) if (names.includes(v)) return role;
  return null;
}

/**
 * Turn a table (array of rows) into notes. Shared by the text and the Excel importer.
 * opts.columns: explicit column names (Anki "#columns:" header), opts.html: fields contain HTML.
 */
export function rowsToImport(rows, { filename, columns, html = false, tagsCol, deckCol, guidCol, notetypeCol, formatLabel } = {}) {
  let data = rows.map((r) => r.map((c) => String(c ?? '').trim())).filter((r) => r.some((c) => c));
  let header = columns || null;
  if (!header && data.length > 1) {
    const first = data[0];
    const roles = first.map(headerRole);
    const langHeaders = first.slice(0, 2).every((c) => KNOWN_LANG_HEADERS.test(c));
    if (roles.filter(Boolean).length >= 2 || langHeaders || (roles[0] && roles[1])) {
      header = first;
      data = data.slice(1);
    }
  }

  let frontIdx = 0;
  let backIdx = 1;
  let extraIdx = [];
  let tagsIdx = tagsCol ?? -1;
  const meta = new Set([tagsCol, deckCol, guidCol, notetypeCol].filter((x) => x !== undefined));
  if (header) {
    const roles = header.map(headerRole);
    if (roles.includes('tags') && tagsIdx < 0) tagsIdx = roles.indexOf('tags');
    meta.add(tagsIdx);
    const contentCols = header.map((_, i) => i).filter((i) => !meta.has(i) && roles[i] !== 'tags');
    const byRole = (role) => contentCols.find((i) => roles[i] === role);
    frontIdx = byRole('front') ?? contentCols[0] ?? 0;
    backIdx = byRole('back') ?? contentCols.find((i) => i !== frontIdx) ?? 1;
    extraIdx = contentCols.filter((i) => i !== frontIdx && i !== backIdx);
  } else {
    const width = Math.max(0, ...data.map((r) => r.length));
    const contentCols = Array.from({ length: width }, (_, i) => i).filter((i) => !meta.has(i));
    frontIdx = contentCols[0] ?? 0;
    backIdx = contentCols[1] ?? 1;
    extraIdx = contentCols.slice(2);
  }

  const toText = html ? htmlToText : (s) => s;
  const decks = new Map();
  const defaultDeck = deckNameFromFile(filename);
  let skipped = 0;
  for (const r of data) {
    const front = toText(r[frontIdx] || '');
    const back = toText(r[backIdx] || '');
    if (!front || !back) {
      skipped++;
      continue;
    }
    const deckName = (deckCol !== undefined && r[deckCol]?.replace(/::/g, ' › ')) || defaultDeck;
    if (!decks.has(deckName)) {
      decks.set(deckName, {
        name: deckName,
        config: header ? labelConfig(header[frontIdx], header[backIdx], extraIdx.length === 1 ? header[extraIdx[0]] : '') : {},
        notes: [],
      });
    }
    decks.get(deckName).notes.push({
      front,
      back,
      extra: extraIdx.map((i) => toText(r[i] || '')).filter(Boolean).join('\n'),
      tags: tagsIdx >= 0 ? r[tagsIdx] || '' : '',
      sourceId: guidCol !== undefined && r[guidCol] ? `anki:${r[guidCol]}` : null,
    });
  }
  const warnings = [];
  if (skipped) warnings.push(`${skipped} Zeile(n) ohne Vorder- oder Rückseite wurden übersprungen.`);
  return { format: 'text', formatLabel: formatLabel || 'Textliste', hasProgress: false, decks: [...decks.values()], warnings };
}

/** Parse CSV / TSV / TXT vocabulary lists, including Anki's "Notizen als Text" export. */
export function parseTextImport(text, filename) {
  const all = text.replace(/\r\n?/g, '\n').split('\n');
  const opts = { filename };
  let sep = null;
  let i = 0;
  for (; i < all.length && all[i].startsWith('#'); i++) {
    const m = all[i].match(/^#([a-z ]+):(.*)$/i);
    if (!m) continue;
    const key = m[1].trim().toLowerCase();
    const value = m[2].trim();
    if (key === 'separator') sep = NAMED_SEPARATORS[value.toLowerCase()] ?? value;
    else if (key === 'html') opts.html = value === 'true';
    else if (key === 'tags column') opts.tagsCol = Number(value) - 1;
    else if (key === 'deck column') opts.deckCol = Number(value) - 1;
    else if (key === 'guid column') opts.guidCol = Number(value) - 1;
    else if (key === 'notetype column') opts.notetypeCol = Number(value) - 1;
    else if (key === 'columns') opts.columns = value.split(sep || '\t');
  }
  const body = all.slice(i);
  sep ||= detectSeparator(body);
  if (opts.columns && sep !== '\t') opts.columns = opts.columns.join('\t').split(sep);
  const rows = parseDelimited(body.join('\n'), sep);
  const label = sep === '\t' ? 'Tabulator-getrennte Liste' : sep === ';' || sep === ',' ? 'CSV-Liste' : 'Textliste';
  return rowsToImport(rows, { ...opts, formatLabel: label });
}
