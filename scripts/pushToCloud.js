// Copies all decks, cards and learning progress from the local SQLite database to the online database.
// Usage (after `npx vercel env pull .env.local`):
//   node --env-file=.env.local scripts/pushToCloud.js
// Safe to run again: cards that already exist online are skipped.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPostgresUrl, openDatabase } from '../server/db.js';
import { parseJsonImport } from '../server/importers/jsonImporter.js';
import { applyImport, exportJson } from '../server/importService.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!isPostgresUrl(target)) {
  console.error('DATABASE_URL fehlt. Erst "npx vercel env pull .env.local" ausführen, dann mit --env-file=.env.local starten.');
  process.exit(1);
}

const local = await openDatabase(process.env.ANKI_REA_DB || path.join(root, 'data', 'anki-rea.db'));
const backup = await exportJson(local);
await local.close();

const cloud = await openDatabase(target);
const result = await applyImport(cloud, parseJsonImport(JSON.stringify(backup), 'backup.json'), { progress: true });
await cloud.close();

console.log(`Online: ${result.added} Karten hinzugefügt, ${result.updated} aktualisiert, ${result.skipped} schon vorhanden.`);
console.log(`Stapel: ${result.decks.map((d) => d.name).join(', ') || '–'}`);
