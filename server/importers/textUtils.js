const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '' };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

/** Convert Anki field HTML into plain text (line breaks kept, media references dropped). */
export function htmlToText(html) {
  return decodeEntities(
    String(html ?? '')
      .replace(/\[sound:[^\]]*\]/gi, '')
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(div|p|li|h\d|tr)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '• ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Turn an Anki cloze text into a question (gaps hidden) and an answer (gaps filled). */
export function clozeToSides(text) {
  const re = /\{\{c\d+::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;
  return {
    front: text.replace(re, (_, _answer, hint) => (hint ? `[${hint}]` : '[…]')),
    back: text.replace(re, (_, answer) => answer),
  };
}

const LANGS = [
  [/^(deutsch|german|de)$/i, 'de-DE'],
  [/^(spanisch|spanish|español|espanol|es)$/i, 'es-ES'],
  [/^(englisch|english|en)$/i, 'en-US'],
  [/^(französisch|franzoesisch|french|français|fr)$/i, 'fr-FR'],
  [/^(italienisch|italian|italiano|it)$/i, 'it-IT'],
  [/^(portugiesisch|portuguese|português|pt)$/i, 'pt-PT'],
  [/^(niederländisch|dutch|nl)$/i, 'nl-NL'],
  [/^(schwedisch|swedish|sv)$/i, 'sv-SE'],
  [/^(polnisch|polish|pl)$/i, 'pl-PL'],
  [/^(russisch|russian|ru)$/i, 'ru-RU'],
  [/^(türkisch|turkish|tr)$/i, 'tr-TR'],
  [/^(japanisch|japanese|ja)$/i, 'ja-JP'],
  [/^(chinesisch|chinese|zh)$/i, 'zh-CN'],
];

export function guessLanguage(label) {
  const s = String(label || '').trim();
  for (const [re, lang] of LANGS) if (re.test(s)) return lang;
  return '';
}

/** Deck display config derived from field/column names. */
export function labelConfig(frontLabel, backLabel, extraLabel) {
  const cfg = {};
  if (frontLabel) cfg.frontLabel = frontLabel;
  if (backLabel) cfg.backLabel = backLabel;
  if (extraLabel) cfg.extraLabel = extraLabel;
  const fl = guessLanguage(frontLabel);
  const bl = guessLanguage(backLabel);
  if (fl) cfg.frontLang = fl;
  if (bl) cfg.backLang = bl;
  return cfg;
}

export function deckNameFromFile(filename) {
  const base = String(filename || '')
    .replace(/^.*[\\/]/, '')
    .replace(/\.[^.]+$/, '')
    .replace(/[_]+/g, ' ')
    .trim();
  return base || 'Importierte Vokabeln';
}
