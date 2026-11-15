import zlib from 'node:zlib';
import { parseAnkiPackage, parseCollectionBuffer } from './ankiImporter.js';
import { parseJsonImport } from './jsonImporter.js';
import { decodeText, parseTextImport } from './textImporter.js';
import { parseXlsxImport } from './xlsxImporter.js';
import { isZip, readZip } from './zipReader.js';

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0');
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** Detect the upload format from its bytes and parse it into { decks: [{ name, config, notes }] }. */
export function parseUpload(buf, filename = '') {
  if (!buf?.length) throw new Error('Die Datei ist leer.');
  const name = filename.toLowerCase();
  if (isZip(buf)) {
    const zip = readZip(buf);
    if (zip.has('xl/workbook.xml')) return parseXlsxImport(zip, filename);
    if (zip.names.some((n) => n.startsWith('collection.anki2'))) return parseAnkiPackage(buf);
    throw new Error('Diese ZIP-Datei ist weder ein Anki-Paket noch eine Excel-Tabelle.');
  }
  if (buf.subarray(0, 16).equals(SQLITE_MAGIC)) return parseCollectionBuffer(buf);
  if (buf.subarray(0, 4).equals(ZSTD_MAGIC)) return parseCollectionBuffer(zlib.zstdDecompressSync(buf));
  if (name.endsWith('.xls')) throw new Error('Alte .xls-Dateien werden nicht unterstützt. Bitte in Excel als .xlsx oder .csv speichern.');
  const text = decodeText(buf);
  const trimmed = text.trimStart();
  if (name.endsWith('.json') || trimmed.startsWith('{') || trimmed.startsWith('[{') || trimmed.startsWith('[[')) {
    return parseJsonImport(text, filename);
  }
  return parseTextImport(text, filename);
}
