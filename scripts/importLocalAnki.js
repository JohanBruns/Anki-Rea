// Imports the vocabulary (including learning progress) straight from the local Anki installation.
// Usage: npm run import-anki [-- "Profilname"]
// The live collection is never modified: it is copied to a temporary folder first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../server/db.js';
import { parseCollectionFile } from '../server/importers/ankiImporter.js';
import { applyImport } from '../server/importService.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ankiDir =
  process.env.ANKI_DIR ||
  (process.platform === 'win32'
    ? path.join(process.env.APPDATA || '', 'Anki2')
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'Anki2')
      : path.join(os.homedir(), '.local', 'share', 'Anki2'));

const profiles = fs.existsSync(ankiDir)
  ? fs.readdirSync(ankiDir).filter((p) => fs.existsSync(path.join(ankiDir, p, 'collection.anki2')))
  : [];
if (!profiles.length) {
  console.error(`Keine Anki-Sammlung gefunden unter ${ankiDir}`);
  process.exit(1);
}
const profile = process.argv[2] || profiles[0];
if (!profiles.includes(profile)) {
  console.error(`Profil "${profile}" nicht gefunden. Vorhanden: ${profiles.join(', ')}`);
  process.exit(1);
}

const src = path.join(ankiDir, profile);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anki-rea-import-'));
try {
  for (const f of ['collection.anki2', 'collection.anki2-wal']) {
    if (fs.existsSync(path.join(src, f))) fs.copyFileSync(path.join(src, f), path.join(tmp, f));
  }
  const parsed = parseCollectionFile(path.join(tmp, 'collection.anki2'));
  const db = await openDatabase(process.env.DATABASE_URL || process.env.ANKI_REA_DB || path.join(root, 'data', 'anki-rea.db'));
  const result = await applyImport(db, parsed, { progress: true });
  await db.close();
  console.log(`Profil "${profile}": ${result.added} neu, ${result.updated} aktualisiert, ${result.skipped} übersprungen.`);
  console.log(`Stapel: ${result.decks.map((d) => d.name).join(', ')}`);
  for (const w of parsed.warnings) console.log(`Hinweis: ${w}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
