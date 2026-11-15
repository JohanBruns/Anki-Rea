import { rowsToImport } from './textImporter.js';

/** Accepts an Anki Rea backup, or a plain list ([["Wort","Übersetzung"], …] or [{front, back}, …]). */
export function parseJsonImport(text, filename) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Die JSON-Datei konnte nicht gelesen werden.');
  }
  if (data && data.app === 'anki-rea' && Array.isArray(data.decks)) {
    return {
      format: 'backup',
      formatLabel: 'Anki-Rea-Backup',
      hasProgress: true,
      decks: data.decks.map((d) => ({
        name: String(d.name || 'Importiert'),
        config: d.config || {},
        notes: (d.notes || []).map((n) => ({
          front: n.front,
          back: n.back,
          extra: n.extra || '',
          tags: n.tags || '',
          sourceId: n.sourceId || null,
          cards: n.cards || [],
        })),
      })),
      warnings: [],
    };
  }
  const list = Array.isArray(data) ? data : Array.isArray(data?.cards) ? data.cards : Array.isArray(data?.notes) ? data.notes : null;
  if (!list) throw new Error('Unbekanntes JSON-Format. Erwartet wird eine Liste von Karten.');
  const rows = list.map((item) => {
    if (Array.isArray(item)) return item;
    if (item && typeof item === 'object') {
      const pick = (...keys) => keys.map((k) => item[k]).find((v) => v !== undefined) ?? '';
      return [
        pick('front', 'vorderseite', 'question', 'frage', 'word', 'wort'),
        pick('back', 'rückseite', 'answer', 'antwort', 'translation', 'übersetzung'),
        pick('extra', 'example', 'beispiel'),
      ];
    }
    return [String(item)];
  });
  return rowsToImport(rows, { filename, formatLabel: 'JSON-Liste' });
}
