import { rowsToImport } from './textImporter.js';
import { decodeEntities } from './textUtils.js';

function columnIndex(ref) {
  const letters = ref.replace(/\d+/g, '');
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const textOf = (xml) =>
  decodeEntities(
    [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''),
  );

/** Read the first worksheet of an Excel (.xlsx) file as rows of strings. */
export function readXlsxRows(zip) {
  const shared = [];
  const sst = zip.read('xl/sharedStrings.xml');
  if (sst) for (const m of sst.toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]));

  const sheetName =
    zip.names.find((n) => n === 'xl/worksheets/sheet1.xml') ||
    zip.names.filter((n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n)).sort()[0];
  if (!sheetName) throw new Error('In der Excel-Datei wurde keine Tabelle gefunden.');
  const xml = zip.read(sheetName).toString('utf8');

  const rows = [];
  for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cm of rm[1].matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const inner = cm[2] || '';
      const ref = attrs.match(/r="([A-Z]+)\d+"/)?.[1];
      const type = attrs.match(/t="([^"]+)"/)?.[1];
      const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let value = '';
      if (type === 's') value = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') value = textOf(inner);
      else if (v !== undefined) value = decodeEntities(v);
      row[ref ? columnIndex(ref) : row.length] = value;
    }
    rows.push(Array.from(row, (c) => c ?? ''));
  }
  return rows;
}

export function parseXlsxImport(zip, filename) {
  return rowsToImport(readXlsxRows(zip), { filename, formatLabel: 'Excel-Tabelle' });
}
