// Anki Rea – single-page app (no build step, no dependencies).

// ---------- helpers ----------

const ICONS = {
  decks: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>',
  cards: '<path d="M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  upload: '<path d="M12 15V3m0 0-4 4m4-4 4 4"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  download: '<path d="M12 3v12m0 0-4-4m4 4 4-4"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  chart: '<path d="M4 20V11M10 20V5M16 20v-6M2 20h20"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  speaker: '<path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>',
  settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
  reset: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  play: '<path d="M7 4.5v15l12-7.5-12-7.5Z"/>',
};

function icon(name) {
  const span = document.createElement('span');
  span.innerHTML = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  return span.firstChild;
}

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

async function api(path, { method = 'GET', body, raw, headers = {} } = {}) {
  const opts = { method, headers: { ...headers } };
  if (raw !== undefined) opts.body = raw;
  else if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers['content-type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(`/api${path}`, opts);
  } catch {
    throw new Error('Keine Verbindung zum Anki-Rea-Server. Läuft er noch?');
  }
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.text();
  if (res.status === 401 && data?.login) {
    loginView();
    throw new LoginRequired();
  }
  if (!res.ok) throw new Error(data?.error || `Fehler ${res.status}`);
  return data;
}

class LoginRequired extends Error {
  constructor() {
    super('Bitte anmelden.');
  }
}

let toastTimer;
function toast(message, kind = '') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), kind === 'error' ? 4500 : 2200);
}

const fmtNumber = (n) => Number(n || 0).toLocaleString('de-DE');

function plural(n, one, many) {
  return `${fmtNumber(n)} ${n === 1 ? one : many}`;
}

function formatWait(ms) {
  const min = Math.max(1, Math.round(ms / 60000));
  if (min < 60) return `${min} Min`;
  const hours = Math.round(min / 6) / 10;
  return `${hours.toLocaleString('de-DE')} Std`;
}

function formatDeadline(ms) {
  return new Date(ms).toLocaleString('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function timeLeft(ms) {
  const diff = ms - Date.now();
  if (diff <= 0) return 'abgelaufen';
  const hours = diff / 3_600_000;
  if (hours < 1) return `noch ${Math.max(1, Math.round(diff / 60000))} Min`;
  if (hours < 36) return `noch ${Math.round(hours)} Std`;
  return `noch ${Math.round(hours / 24)} Tage`;
}

/** Value for <input type="datetime-local"> in local time. */
function toLocalInput(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function deadlineBox(deck) {
  const dl = deck.counts.deadline;
  if (!dl) {
    return h('a', { class: 'deadline-link', href: `#/deck/${deck.id}` }, icon('target'), 'Prüfungstermin festlegen');
  }
  const pct = dl.active ? Math.round((dl.mastered / dl.active) * 100) : 0;
  const allDone = dl.mastered >= dl.active;
  const newLeft = deck.counts.new + deck.counts.newRemaining;
  return h(
    'div',
    { class: 'deadline-box' },
    h('div', { class: 'deadline-head' }, icon('target'), h('strong', {}, formatDeadline(dl.at)), h('span', { class: 'muted' }, timeLeft(dl.at))),
    h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('div', { style: `width:${pct}%` })),
    h(
      'div',
      { class: 'deadline-meta' },
      h('span', {}, `${fmtNumber(dl.mastered)} von ${fmtNumber(dl.active)} gelernt`),
      allDone
        ? h('span', {}, 'Jetzt nur noch wiederholen')
        : deck.counts.new
          ? h('span', {}, `Heute noch ${fmtNumber(deck.counts.new)} neue`)
          : newLeft
            ? h('span', {}, 'Tagesziel erreicht')
            : h('span', {}, 'Alle Karten eingeführt'),
    ),
  );
}

function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

// ---------- dialogs ----------

function openSheet(build) {
  return new Promise((resolve) => {
    const dialog = h('dialog', { class: 'sheet' });
    const body = h('div', { class: 'sheet-body' });
    dialog.append(body);
    document.body.append(dialog);
    let settled = false;
    const close = (value) => {
      if (settled) return;
      settled = true;
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) close(null);
    });
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      close(null);
    });
    build(body, close);
    dialog.showModal();
  });
}

function confirmDialog(title, text, okLabel = 'OK', danger = false) {
  return openSheet((body, close) => {
    body.append(
      h('h2', {}, title),
      text ? h('p', { class: 'muted' }, text) : null,
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'btn ghost', onclick: () => close(false) }, 'Abbrechen'),
        h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => close(true) }, okLabel),
      ),
    );
  });
}

function promptDialog(title, label, initial = '', okLabel = 'Speichern') {
  return openSheet((body, close) => {
    const input = h('input', { type: 'text', value: initial, autocomplete: 'off' });
    const form = h(
      'form',
      {
        onsubmit: (e) => {
          e.preventDefault();
          if (input.value.trim()) close(input.value.trim());
        },
      },
      h('h2', {}, title),
      h('label', { class: 'field' }, h('span', {}, label), input),
      h(
        'div',
        { class: 'row' },
        h('button', { type: 'button', class: 'btn ghost', onclick: () => close(null) }, 'Abbrechen'),
        h('button', { type: 'submit', class: 'btn primary' }, okLabel),
      ),
    );
    body.append(form);
    setTimeout(() => input.focus(), 50);
  });
}

// ---------- text to speech ----------

function canSpeak() {
  return 'speechSynthesis' in window;
}

function speak(text, lang) {
  if (!canSpeak() || !lang || !text) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replace(/\(.*?\)/g, ' '));
  u.lang = lang;
  const prefix = lang.slice(0, 2).toLowerCase();
  const voices = speechSynthesis.getVoices();
  const voice = voices.find((v) => v.lang.replace('_', '-').toLowerCase() === lang.toLowerCase()) || voices.find((v) => v.lang.toLowerCase().startsWith(prefix));
  if (voice) u.voice = voice;
  u.rate = 0.92;
  speechSynthesis.speak(u);
}

function speakButton(text, lang) {
  if (!canSpeak() || !lang) return null;
  return h(
    'button',
    {
      class: 'icon-btn speak',
      title: 'Vorlesen',
      'aria-label': 'Vorlesen',
      onclick: (e) => {
        e.stopPropagation();
        speak(text, lang);
      },
    },
    icon('speaker'),
  );
}

// ---------- router ----------

const view = document.getElementById('view');
let cleanups = [];
const onCleanup = (fn) => cleanups.push(fn);

function onKey(handler) {
  document.addEventListener('keydown', handler);
  onCleanup(() => document.removeEventListener('keydown', handler));
}

const routes = [
  [/^#?\/?$/, 'home', () => homeView()],
  [/^#\/study\/(\d+)$/, 'home', (m) => studyView(Number(m[1]))],
  [/^#\/deck\/(\d+)$/, 'home', (m) => deckOptionsView(Number(m[1]))],
  [/^#\/browse(?:\?(.*))?$/, 'browse', (m) => browseView(new URLSearchParams(m[1] || ''))],
  [/^#\/note\/(\d+)$/, 'browse', (m) => noteView(Number(m[1]))],
  [/^#\/add(?:\?(.*))?$/, 'browse', (m) => noteView(null, new URLSearchParams(m[1] || ''))],
  [/^#\/import$/, 'import', () => importView()],
  [/^#\/stats(?:\?(.*))?$/, 'stats', (m) => statsView(new URLSearchParams(m[1] || ''))],
];

async function render() {
  for (const fn of cleanups) fn();
  cleanups = [];
  if (canSpeak()) speechSynthesis.cancel();
  document.body.classList.remove('studying');
  const hash = location.hash || '#/';
  const match = routes.map(([re, nav, fn]) => [hash.match(re), nav, fn]).find(([m]) => m);
  const [m, nav, fn] = match || [[], 'home', () => homeView()];
  for (const link of document.querySelectorAll('.nav-link')) link.classList.toggle('active', link.dataset.route === nav);
  view.replaceChildren(h('div', { class: 'spinner' }));
  try {
    await fn(m);
  } catch (err) {
    if (err instanceof LoginRequired) return;
    view.replaceChildren(
      h('div', { class: 'card empty' }, h('h2', {}, 'Das hat nicht geklappt'), h('p', {}, err.message), h('a', { class: 'btn primary', href: '#/' }, 'Zur Übersicht')),
    );
  }
  view.focus({ preventScroll: true });
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function pageHead(title, sub, ...actions) {
  return h('header', { class: 'page-head' }, h('div', { style: 'flex:1;min-width:0' }, h('h1', {}, title), sub ? h('div', { class: 'sub' }, sub) : null), ...actions);
}

// ---------- login ----------

let loginShown = false;
function loginView() {
  if (loginShown) return;
  loginShown = true;
  for (const fn of cleanups) fn();
  cleanups = [];
  document.body.classList.add('studying');
  const input = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Passwort', 'aria-label': 'Passwort' });
  const btn = h('button', { type: 'submit', class: 'btn primary big wide' }, 'Anmelden');
  const form = h(
    'form',
    {
      class: 'card login',
      onsubmit: async (e) => {
        e.preventDefault();
        btn.disabled = true;
        try {
          const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ password: input.value }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'Anmeldung fehlgeschlagen.');
          loginShown = false;
          render();
        } catch (err) {
          toast(err.message, 'error');
          input.select();
        } finally {
          btn.disabled = false;
        }
      },
    },
    h('img', { src: '/icons/icon.svg', alt: '', width: 72, height: 72 }),
    h('h1', {}, 'Anki Rea'),
    h('p', { class: 'muted' }, 'Bitte melde dich an. Auf diesem Gerät bleibst du danach angemeldet.'),
    h('label', { class: 'field' }, input),
    btn,
  );
  view.replaceChildren(h('div', { class: 'login-wrap' }, form));
  setTimeout(() => input.focus(), 50);
}

// ---------- home ----------

async function homeView() {
  const [decks, info, session] = await Promise.all([api('/decks'), api('/info').catch(() => null), api('/session').catch(() => null)]);
  const due = decks.reduce((s, d) => s + d.counts.new + d.counts.learn + d.counts.review, 0);
  const content = [];
  content.push(
    pageHead(
      'Deine Stapel',
      decks.length ? (due ? `Heute noch ${plural(due, 'Karte', 'Karten')} zu lernen` : 'Für heute alles erledigt') : null,
      h('button', { class: 'btn ghost', onclick: createDeckFlow }, icon('plus'), h('span', {}, 'Stapel')),
    ),
  );

  if (!decks.length) {
    content.push(
      h(
        'div',
        { class: 'card empty' },
        h('h2', {}, 'Noch keine Vokabeln'),
        h('p', {}, 'Lade deine Vokabelliste hoch – als Anki-Datei, Excel-Tabelle, CSV oder einfach als Text.'),
        h('a', { class: 'btn primary big', href: '#/import' }, icon('upload'), 'Vokabeln hochladen'),
      ),
    );
  } else {
    content.push(
      h(
        'div',
        { class: 'deck-grid' },
        decks.map((d) => {
          const todo = d.counts.new + d.counts.learn + d.counts.review;
          return h(
            'article',
            { class: 'deck-card' },
            h(
              'div',
              { class: 'deck-top' },
              h('h2', {}, d.name),
              h('a', { class: 'icon-btn', href: `#/deck/${d.id}`, title: 'Stapel-Optionen', 'aria-label': 'Stapel-Optionen' }, icon('settings')),
            ),
            h(
              'div',
              { class: 'counts' },
              h('div', { class: 'count new' }, h('b', {}, fmtNumber(d.counts.new)), h('span', {}, 'Neu')),
              h('div', { class: 'count learn' }, h('b', {}, fmtNumber(d.counts.learn)), h('span', {}, 'Lernen')),
              h('div', { class: 'count review' }, h('b', {}, fmtNumber(d.counts.review)), h('span', {}, 'Wiederholen')),
            ),
            h('div', { class: 'deck-meta' }, `${plural(d.counts.total, 'Karte', 'Karten')} im Stapel`),
            deadlineBox(d),
            h('a', { class: `btn big wide ${todo ? 'primary' : 'ghost'}`, href: `#/study/${d.id}` }, todo ? 'Jetzt lernen' : icon('check'), todo ? null : 'Fertig für heute'),
          );
        }),
      ),
    );
  }

  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (info?.urls?.length && local) {
    content.push(
      h(
        'div',
        { class: 'card phone-hint' },
        icon('phone'),
        h(
          'div',
          {},
          h('div', { class: 'muted' }, 'Auf dem Handy öffnen (gleiches WLAN):'),
          info.urls.map((u) => h('div', {}, h('code', {}, u))),
          h('small', { class: 'muted' }, 'Tipp: Im Handy-Browser „Zum Startbildschirm hinzufügen“ – dann startet Anki Rea wie eine App.'),
        ),
      ),
    );
  }
  if (!window.matchMedia('(display-mode: standalone)').matches && !local) {
    content.push(
      h(
        'div',
        { class: 'card phone-hint' },
        icon('phone'),
        h(
          'div',
          {},
          h('strong', {}, 'Als App auf den Startbildschirm'),
          h(
            'div',
            { class: 'muted' },
            /iphone|ipad/i.test(navigator.userAgent)
              ? 'In Safari unten auf „Teilen“ tippen und „Zum Home-Bildschirm“ wählen.'
              : 'Im Browser-Menü (⋮) „App installieren“ oder „Zum Startbildschirm hinzufügen“ wählen.',
          ),
        ),
      ),
    );
  }
  if (session?.authRequired) {
    content.push(
      h(
        'button',
        {
          class: 'btn ghost',
          onclick: async () => {
            await fetch('/api/logout', { method: 'POST' });
            loginView();
          },
        },
        'Abmelden',
      ),
    );
  }
  view.replaceChildren(...content);
}

async function createDeckFlow() {
  const name = await promptDialog('Neuer Stapel', 'Name', '', 'Erstellen');
  if (!name) return;
  try {
    await api('/decks', { method: 'POST', body: { name } });
    toast('Stapel erstellt');
    render();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------- study ----------

async function studyView(deckId) {
  document.body.classList.add('studying');
  let data = null;
  let revealed = false;
  let shownAt = 0;
  let revealedAt = 0;
  let busy = false;
  let timer = null;
  let ahead = false; // "Weiterlernen": keep going after the day's cards are done
  onCleanup(() => clearTimeout(timer));

  const nameEl = h('div', { class: 'name' });
  const countsEl = h('div', { class: 'study-counts' });
  const stage = h('section', { class: 'stage', onclick: () => !revealed && data?.card && reveal() });
  const bar = h('footer', { class: 'answer-bar' });
  const top = h(
    'header',
    { class: 'study-top' },
    h('a', { class: 'icon-btn', href: '#/', title: 'Zurück', 'aria-label': 'Zurück' }, icon('back')),
    h('div', { class: 'study-title' }, nameEl, countsEl),
    h('button', { class: 'icon-btn', title: 'Rückgängig (Z)', 'aria-label': 'Rückgängig', onclick: doUndo }, icon('undo')),
    h('button', { class: 'icon-btn', title: 'Mehr', 'aria-label': 'Mehr', onclick: openMenu }, icon('more')),
  );
  view.replaceChildren(h('div', { class: 'study' }, top, stage, bar));

  function renderCounts() {
    const c = data.counts;
    const current = data.card ? (data.card.state === 'new' ? 'new' : data.card.state === 'review' ? 'review' : 'learn') : '';
    countsEl.replaceChildren(
      h('span', { class: `new ${current === 'new' ? 'current' : ''}`, title: 'Neu' }, c.new),
      h('span', { class: `learn ${current === 'learn' ? 'current' : ''}`, title: 'Lernen' }, c.learn),
      h('span', { class: `review ${current === 'review' ? 'current' : ''}`, title: 'Wiederholen' }, c.review),
    );
    nameEl.textContent = ahead ? `${data.deck.name} · Weiterlernen` : data.deck.name;
  }

  function show(next) {
    data = next;
    revealed = false;
    busy = false;
    clearTimeout(timer);
    renderCounts();
    if (data.done) return renderDone();
    shownAt = Date.now();
    renderCard();
    if (data.deck.autoplay) speak(data.card.front, data.card.frontLang);
  }

  function renderCard() {
    const c = data.card;
    stage.classList.toggle('revealed', revealed);
    stage.replaceChildren(
      h(
        'div',
        { class: 'face' },
        h('div', { class: 'label' }, c.frontLabel),
        h('div', { class: 'q' }, c.front, speakButton(c.front, c.frontLang)),
        revealed
          ? [
              h('div', { class: 'divider' }),
              h('div', { class: 'label' }, c.backLabel),
              h('div', { class: 'a' }, c.back, speakButton(c.back, c.backLang)),
              c.extra ? h('div', { class: 'extra' }, c.extra, speakButton(c.extra, c.ord === 0 ? c.backLang : c.frontLang)) : null,
            ]
          : h('div', { class: 'tap-hint' }, 'Tippe auf die Karte oder auf „Antwort zeigen“'),
      ),
    );
    if (!revealed) {
      bar.replaceChildren(
        h('button', { class: 'btn primary reveal-btn', onclick: reveal }, 'Antwort zeigen', h('span', { class: 'kbd' }, 'Leertaste')),
      );
    } else {
      const p = data.previews;
      const btn = (n, label, cls) =>
        h(
          'button',
          { class: `rate ${cls}`, onclick: () => rate(n) },
          h('span', { class: 'label' }, label),
          h('span', { class: 'ivl' }, p[n], h('span', { class: 'kbd' }, n)),
        );
      bar.replaceChildren(h('div', { class: 'rates' }, btn(1, 'Nochmal', 'again'), btn(2, 'Schwer', 'hard'), btn(3, 'Gut', 'good'), btn(4, 'Einfach', 'easy')));
    }
  }

  function reveal() {
    if (!data?.card || revealed) return;
    revealed = true;
    revealedAt = Date.now();
    renderCard();
    if (data.deck.autoplay) speak(data.card.back, data.card.backLang);
  }

  async function rate(n) {
    // Ignore taps that land on the rating buttons right after revealing (double tap on "Antwort zeigen").
    if (!revealed || busy || Date.now() - revealedAt < 300) return;
    busy = true;
    try {
      show(await api(`/cards/${data.card.id}/answer`, { method: 'POST', body: { rating: n, timeMs: Date.now() - shownAt, ahead } }));
    } catch (err) {
      busy = false;
      toast(err.message, 'error');
    }
  }

  async function doUndo() {
    try {
      show(await api(`/decks/${deckId}/undo${ahead ? '?ahead=1' : ''}`, { method: 'POST' }));
      toast('Rückgängig gemacht');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function reload(params = {}) {
    const q = new URLSearchParams(params);
    if (ahead) q.set('ahead', '1');
    show(await api(`/decks/${deckId}/next${q.size ? `?${q}` : ''}`));
  }

  async function studyAhead() {
    ahead = true;
    try {
      await reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function renderDone() {
    stage.classList.add('revealed');
    const c = data.counts;
    const waiting = data.nextDue ? data.nextDue - Date.now() : null;
    stage.replaceChildren(
      h(
        'div',
        { class: 'done' },
        h('div', { class: 'check-circle' }, icon('check')),
        h('h2', {}, 'Geschafft!'),
        h('p', { class: 'muted' }, waiting ? `Für den Moment bist du fertig. Die nächste Karte ist in ${formatWait(waiting)} wieder dran.` : 'Für heute hast du alle Karten in diesem Stapel gelernt.'),
        c.deadline
          ? h(
              'p',
              { class: 'muted' },
              `Ziel ${formatDeadline(c.deadline.at)} (${timeLeft(c.deadline.at)}): ${fmtNumber(c.deadline.mastered)} von ${fmtNumber(c.deadline.active)} Karten gelernt.`,
            )
          : null,
        h(
          'div',
          { class: 'row' },
          data.canStudyAhead
            ? h('button', { class: 'btn primary big', onclick: studyAhead }, icon('play'), 'Weiterlernen')
            : null,
          c.newRemaining
            ? h(
                'button',
                {
                  class: `btn ${data.canStudyAhead ? 'ghost' : 'primary'} big`,
                  onclick: async () => {
                    try {
                      show(await api(`/decks/${deckId}/extend`, { method: 'POST', body: { newCards: 10 } }));
                    } catch (err) {
                      toast(err.message, 'error');
                    }
                  },
                },
                `10 weitere neue Karten (${fmtNumber(c.newRemaining)} übrig)`,
              )
            : null,
          h('a', { class: 'btn ghost big', href: '#/' }, 'Zur Übersicht'),
          h('a', { class: 'btn ghost big', href: `#/add?deck=${deckId}` }, icon('plus'), 'Karte hinzufügen'),
        ),
      ),
    );
    bar.replaceChildren();
    if (waiting && waiting < 6 * 3600_000) {
      // Learning cards become available again up to 20 minutes early (Anki's learn-ahead limit).
      timer = setTimeout(() => reload().catch(() => {}), Math.max(5000, waiting - 20 * 60_000 + 1000));
    }
  }

  async function editCurrent() {
    if (!data?.card) return;
    const note = await api(`/notes/${data.card.noteId}`);
    const saved = await openSheet((body, close) => {
      body.append(h('h2', {}, 'Karte bearbeiten'));
      body.append(noteForm({ note, decks: null, labels: labelsFromCard(data.card), onSaved: close, onCancel: () => close(null) }));
    });
    if (saved) {
      const wasRevealed = revealed;
      await reload({ card: data.card.id });
      if (wasRevealed) reveal();
      toast('Gespeichert');
    }
  }

  async function suspendCurrent() {
    if (!data?.card) return;
    try {
      show(await api(`/cards/${data.card.id}/suspend`, { method: 'POST', body: { suspended: true, ahead } }));
      toast('Karte ausgesetzt – sie kommt erst wieder, wenn du sie unter „Karten“ reaktivierst.');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function openMenu() {
    openSheet((body, close) => {
      const item = (ic, label, fn, disabled = false) =>
        h(
          'button',
          {
            class: 'btn',
            disabled,
            onclick: () => {
              close();
              fn();
            },
          },
          icon(ic),
          label,
        );
      const has = !!data?.card;
      body.append(
        h('h2', {}, data?.deck?.name || 'Lernen'),
        h(
          'div',
          { class: 'menu-list' },
          item('edit', 'Karte bearbeiten (E)', editCurrent, !has),
          item('undo', 'Letzte Antwort rückgängig (Z)', doUndo),
          item('pause', 'Karte aussetzen', suspendCurrent, !has),
          item('speaker', 'Vorlesen (R)', () => speakCurrent(), !has || !canSpeak()),
          item('plus', 'Neue Karte hinzufügen', () => go(`#/add?deck=${deckId}`)),
          item('settings', 'Stapel-Optionen', () => go(`#/deck/${deckId}`)),
        ),
      );
    });
  }

  function speakCurrent() {
    if (!data?.card) return;
    if (revealed) speak(data.card.back, data.card.backLang);
    else speak(data.card.front, data.card.frontLang);
  }

  onKey((e) => {
    if (isTyping(e) || document.querySelector('dialog[open]') || e.metaKey || e.altKey) return;
    if (e.ctrlKey) {
      if (e.key === 'z') {
        e.preventDefault();
        doUndo();
      }
      return;
    }
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (!revealed) reveal();
      else rate(3);
    } else if (['1', '2', '3', '4'].includes(e.key)) rate(Number(e.key));
    else if (e.key === 'z' || e.key === 'Z') doUndo();
    else if (e.key === 'e' || e.key === 'E') editCurrent();
    else if (e.key === 'r' || e.key === 'R') speakCurrent();
    else if (e.key === 'Escape') go('#/');
  });

  await reload();
}

function labelsFromCard(c) {
  return c.ord === 0
    ? { front: c.frontLabel, back: c.backLabel, extra: c.extraLabel }
    : { front: c.backLabel, back: c.frontLabel, extra: c.extraLabel };
}

// ---------- note form ----------

function noteForm({ note, decks, deckId, labels, onSaved, onCancel, keepOpen = false }) {
  const isNew = !note?.id;
  const deckSelect = decks
    ? h(
        'select',
        { onchange: () => updateLabels() },
        decks.map((d) => h('option', { value: d.id }, d.name)),
      )
    : null;
  if (deckSelect) deckSelect.value = String(note?.deckId || deckId || decks[0]?.id || '');
  const front = h('textarea', { rows: 2, value: note?.front || '', required: true });
  const back = h('textarea', { rows: 2, value: note?.back || '', required: true });
  const extra = h('textarea', { rows: 3, value: note?.extra || '' });
  const tags = h('input', { type: 'text', value: note?.tags || '', placeholder: 'z. B. kapitel1 verben' });
  const frontLabel = h('span', {});
  const backLabel = h('span', {});
  const extraLabel = h('span', {});
  const deckLabels = new Map((decks || []).map((d) => [String(d.id), d.labels]));

  function updateLabels() {
    const l = (deckSelect && deckLabels.get(deckSelect.value)) || labels || {};
    frontLabel.textContent = l.front || 'Vorderseite';
    backLabel.textContent = l.back || 'Rückseite';
    extraLabel.textContent = `${l.extra || 'Beispiel'} (optional)`;
  }
  updateLabels();

  const saveBtn = h('button', { type: 'submit', class: 'btn primary' }, isNew ? 'Hinzufügen' : 'Speichern');
  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        if (!front.value.trim() || !back.value.trim()) {
          toast('Bitte Vorder- und Rückseite ausfüllen.', 'error');
          return;
        }
        saveBtn.disabled = true;
        const payload = { front: front.value, back: back.value, extra: extra.value, tags: tags.value };
        if (deckSelect) payload.deckId = Number(deckSelect.value);
        try {
          const saved = isNew
            ? await api('/notes', { method: 'POST', body: payload })
            : await api(`/notes/${note.id}`, { method: 'PATCH', body: payload });
          if (keepOpen) {
            front.value = '';
            back.value = '';
            extra.value = '';
            front.focus();
            toast('Karte hinzugefügt');
          }
          onSaved?.(saved);
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          saveBtn.disabled = false;
        }
      },
    },
    deckSelect ? h('label', { class: 'field' }, h('span', {}, 'Stapel'), deckSelect) : null,
    h('label', { class: 'field' }, frontLabel, front),
    h('label', { class: 'field' }, backLabel, back),
    h('label', { class: 'field' }, extraLabel, extra),
    h('label', { class: 'field' }, h('span', {}, 'Tags (optional)'), tags),
    h('div', { class: 'row' }, onCancel ? h('button', { type: 'button', class: 'btn ghost', onclick: onCancel }, 'Abbrechen') : null, saveBtn),
  );
  if (isNew) setTimeout(() => front.focus(), 50);
  return form;
}

async function decksWithLabels() {
  const decks = await api('/decks');
  const details = await Promise.all(decks.map((d) => api(`/decks/${d.id}`)));
  return details.map((d) => ({ id: d.id, name: d.name, labels: { front: d.config.frontLabel, back: d.config.backLabel, extra: d.config.extraLabel } }));
}

async function noteView(id, params) {
  const decks = await decksWithLabels();
  if (!decks.length) {
    view.replaceChildren(
      pageHead('Neue Karte'),
      h('div', { class: 'card empty' }, h('p', {}, 'Lege zuerst einen Stapel an oder lade Vokabeln hoch.'), h('a', { class: 'btn primary', href: '#/import' }, 'Zum Import')),
    );
    return;
  }
  if (!id) {
    const deckId = Number(params?.get('deck')) || decks[0].id;
    view.replaceChildren(
      pageHead('Neue Karte', 'Nach dem Speichern kannst du direkt die nächste eingeben.'),
      h('div', { class: 'card' }, noteForm({ decks, deckId, keepOpen: true, onCancel: () => history.back() })),
    );
    return;
  }
  const note = await api(`/notes/${id}`);
  const card = note.cards.find((c) => c.ord === 0);
  const suspended = note.cards.every((c) => c.suspended);
  const stateText = !card
    ? ''
    : suspended
      ? 'Ausgesetzt'
      : card.state === 'new'
        ? 'Neu – noch nicht gelernt'
        : card.state === 'review'
          ? `Intervall ${plural(card.ivl, 'Tag', 'Tage')}, ${card.dueDays <= 0 ? 'heute fällig' : `fällig in ${plural(card.dueDays, 'Tag', 'Tagen')}`} · ${card.reps}× wiederholt`
          : `In der Lernphase · ${card.reps}× wiederholt`;

  view.replaceChildren(
    pageHead('Karte bearbeiten', stateText, h('a', { class: 'icon-btn', href: '#/browse', 'aria-label': 'Zurück' }, icon('back'))),
    h('div', { class: 'card' }, noteForm({ note, decks, onSaved: () => (toast('Gespeichert'), history.back()), onCancel: () => history.back() })),
    h(
      'div',
      { class: 'card' },
      h('h2', {}, 'Weitere Aktionen'),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            class: 'btn ghost',
            onclick: async () => {
              await api(`/notes/${id}`, { method: 'PATCH', body: { suspended: !suspended } });
              toast(suspended ? 'Karte wieder aktiv' : 'Karte ausgesetzt');
              render();
            },
          },
          icon('pause'),
          suspended ? 'Reaktivieren' : 'Aussetzen',
        ),
        h(
          'button',
          {
            class: 'btn ghost',
            onclick: async () => {
              if (!(await confirmDialog('Fortschritt zurücksetzen?', 'Die Karte gilt danach wieder als neu.', 'Zurücksetzen'))) return;
              await api(`/notes/${id}/reset`, { method: 'POST' });
              toast('Fortschritt zurückgesetzt');
              render();
            },
          },
          icon('reset'),
          'Als neu markieren',
        ),
        h(
          'button',
          {
            class: 'btn danger',
            onclick: async () => {
              if (!(await confirmDialog('Karte löschen?', `„${note.front}“ wird endgültig gelöscht.`, 'Löschen', true))) return;
              await api(`/notes/${id}`, { method: 'DELETE' });
              toast('Karte gelöscht');
              go('#/browse');
            },
          },
          icon('trash'),
          'Löschen',
        ),
      ),
    ),
  );
}

// ---------- browse ----------

function stateBadge(card) {
  if (!card) return null;
  if (card.suspended) return h('span', { class: 'badge' }, 'Ausgesetzt');
  if (card.state === 'new') return h('span', { class: 'badge new' }, 'Neu');
  if (card.state === 'review') {
    if (card.due > Date.now() && card.dueDays <= 1) {
      // Deadline mode schedules reviews to the hour.
      const time = new Date(card.due).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
      return h('span', { class: 'badge review' }, card.dueDays <= 0 ? `um ${time}` : `morgen ${time}`);
    }
    return h('span', { class: 'badge review' }, card.dueDays <= 0 ? 'fällig' : `in ${card.dueDays} T`);
  }
  return h('span', { class: 'badge learn' }, 'Lernen');
}

async function browseView(params) {
  const decks = await api('/decks');
  let deck = params.get('deck') || '';
  let q = params.get('q') || '';
  let offset = 0;
  const list = h('ul', { class: 'note-list' });
  const foot = h('div', { class: 'list-foot' });
  const search = h('input', { type: 'search', placeholder: 'Suchen …', value: q, 'aria-label': 'Karten durchsuchen' });
  const select = h(
    'select',
    { 'aria-label': 'Stapel' },
    h('option', { value: '' }, 'Alle Stapel'),
    decks.map((d) => h('option', { value: d.id }, d.name)),
  );
  select.value = deck;

  async function load(reset) {
    if (reset) offset = 0;
    const qs = new URLSearchParams({ deck, q, offset, limit: 60 });
    const data = await api(`/notes?${qs}`);
    const rows = data.notes.map((n) =>
      h(
        'li',
        {},
        h(
          'a',
          { class: 'note-row', href: `#/note/${n.id}` },
          h('div', { class: 'note-main' }, h('div', { class: 'note-front' }, n.front), h('div', { class: 'note-back' }, n.back)),
          stateBadge(n.card),
        ),
      ),
    );
    if (reset) list.replaceChildren(...rows);
    else list.append(...rows);
    offset += data.notes.length;
    foot.replaceChildren(
      data.total === 0
        ? q
          ? 'Keine Treffer.'
          : 'Noch keine Karten.'
        : `${fmtNumber(Math.min(offset, data.total))} von ${plural(data.total, 'Karte', 'Karten')}`,
      offset < data.total ? h('div', { style: 'margin-top:12px' }, h('button', { class: 'btn ghost', onclick: () => load(false) }, 'Mehr anzeigen')) : null,
    );
    list.hidden = data.total === 0;
  }

  let debounce;
  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      q = search.value.trim();
      history.replaceState(null, '', `#/browse?${new URLSearchParams({ deck, q })}`);
      load(true);
    }, 220);
  });
  select.addEventListener('change', () => {
    deck = select.value;
    history.replaceState(null, '', `#/browse?${new URLSearchParams({ deck, q })}`);
    load(true);
  });

  view.replaceChildren(
    pageHead('Karten', null, h('a', { class: 'btn primary', href: `#/add${deck ? `?deck=${deck}` : ''}` }, icon('plus'), h('span', {}, 'Neu'))),
    h('div', { class: 'toolbar' }, h('div', { class: 'search' }, icon('search'), search), select),
    list,
    foot,
  );
  await load(true);
}

// ---------- import / export ----------

async function importView() {
  const decks = await api('/decks');
  const result = h('div', {});
  const fileInput = h('input', {
    type: 'file',
    accept: '.apkg,.colpkg,.anki2,.anki21,.csv,.tsv,.txt,.xlsx,.json,text/plain,text/csv',
    onchange: () => fileInput.files[0] && upload(fileInput.files[0], fileInput.files[0].name),
  });
  const drop = h(
    'label',
    { class: 'drop' },
    icon('upload'),
    h('strong', {}, 'Datei auswählen'),
    h('span', { class: 'muted' }, 'oder hierher ziehen'),
    h('small', { class: 'muted' }, 'Anki (.apkg, .colpkg), Excel (.xlsx), CSV, TXT, JSON'),
    fileInput,
  );
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = e.dataTransfer.files[0];
    if (f) upload(f, f.name);
  });

  const paste = h('textarea', { rows: 6, placeholder: 'die Mehrheit - la mayoría\nbetteln - mendigar\nverkaufen - vender' });
  const pasteName = h('input', { type: 'text', placeholder: 'Name des Stapels', value: '' });

  async function upload(blob, name) {
    result.replaceChildren(h('div', { class: 'spinner' }));
    try {
      const preview = await api('/import/preview', {
        method: 'POST',
        raw: blob,
        headers: { 'x-filename': encodeURIComponent(name), 'content-type': 'application/octet-stream' },
      });
      renderPreview(preview, blob, name);
      result.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      result.replaceChildren(h('div', { class: 'notice warn' }, err.message));
    } finally {
      fileInput.value = '';
    }
  }

  function renderPreview(p, blob, filename) {
    const single = p.decks.length === 1;
    const target = h(
      'select',
      {},
      h('option', { value: 'new' }, single ? 'Neuer Stapel' : 'Jeweils eigener Stapel (wie in der Datei)'),
      decks.map((d) => h('option', { value: d.id }, `In „${d.name}“ einfügen`)),
    );
    const sameName = single && decks.find((d) => d.name.toLowerCase() === p.decks[0].name.toLowerCase());
    if (sameName) target.value = String(sameName.id);
    const nameInput = h('input', { type: 'text', value: single ? p.decks[0].name : '' });
    const nameField = h('label', { class: 'field' }, h('span', {}, 'Name des neuen Stapels'), nameInput);
    const syncName = () => (nameField.hidden = !single || target.value !== 'new');
    target.addEventListener('change', syncName);
    syncName();
    const progress = h('input', { type: 'checkbox', checked: true });
    const importBtn = h('button', { class: 'btn primary big wide' }, `${plural(p.total, 'Karte', 'Karten')} importieren`);
    importBtn.addEventListener('click', async () => {
      importBtn.disabled = true;
      try {
        const qs = new URLSearchParams({
          token: p.token,
          deckId: target.value === 'new' ? '' : target.value,
          deckName: nameInput.value.trim(),
          progress: p.hasProgress && progress.checked ? '1' : '0',
        });
        // The file is sent again: online, the preview may have been made by another server instance.
        const r = await api(`/import/commit?${qs}`, {
          method: 'POST',
          raw: blob,
          headers: { 'x-filename': encodeURIComponent(filename), 'content-type': 'application/octet-stream' },
        });
        const studyDeck = r.decks[0];
        result.replaceChildren(
          h(
            'div',
            { class: 'card' },
            h('h2', {}, 'Import abgeschlossen'),
            h(
              'div',
              { class: 'notice ok' },
              `${plural(r.added, 'Karte', 'Karten')} hinzugefügt`,
              r.updated ? `, ${fmtNumber(r.updated)} aktualisiert` : '',
              r.skipped ? `, ${fmtNumber(r.skipped)} schon vorhanden (übersprungen)` : '',
              '.',
            ),
            h(
              'div',
              { class: 'row' },
              studyDeck ? h('a', { class: 'btn primary big', href: `#/study/${studyDeck.id}` }, `„${studyDeck.name}“ lernen`) : null,
              h('a', { class: 'btn ghost big', href: '#/' }, 'Zur Übersicht'),
            ),
          ),
        );
      } catch (err) {
        importBtn.disabled = false;
        toast(err.message, 'error');
      }
    });

    result.replaceChildren(
      h(
        'div',
        { class: 'card' },
        h('h2', {}, 'Vorschau'),
        h('p', { class: 'muted' }, `${p.formatLabel} · ${plural(p.total, 'Karte', 'Karten')} erkannt`),
        p.warnings.map((w) => h('div', { class: 'notice warn' }, w)),
        p.decks.map((d) =>
          h(
            'div',
            {},
            p.decks.length > 1 ? h('h3', {}, `${d.name} (${fmtNumber(d.count)})`) : null,
            h(
              'div',
              { class: 'table-wrap' },
              h(
                'table',
                { class: 'sample' },
                h('thead', {}, h('tr', {}, h('th', {}, d.labels.front), h('th', {}, d.labels.back), h('th', {}, d.labels.extra))),
                h(
                  'tbody',
                  {},
                  d.sample.map((s) => h('tr', {}, h('td', {}, s.front), h('td', {}, s.back), h('td', { class: 'muted' }, s.extra))),
                ),
              ),
            ),
            d.count > d.sample.length ? h('p', { class: 'muted' }, `… und ${fmtNumber(d.count - d.sample.length)} weitere`) : null,
          ),
        ),
        h('label', { class: 'field' }, h('span', {}, 'Ziel'), target),
        nameField,
        p.hasProgress ? h('label', { class: 'check' }, progress, 'Lernfortschritt übernehmen (Intervalle, Fälligkeiten)') : null,
        importBtn,
      ),
    );
  }

  const exportSelect = h('select', {}, h('option', { value: '' }, 'Alle Stapel'), decks.map((d) => h('option', { value: d.id }, d.name)));
  const exportLink = (format) => `/api/export?${new URLSearchParams({ format, deck: exportSelect.value })}`;

  view.replaceChildren(
    pageHead('Vokabeln hochladen', 'Deine Listen werden auf dem Anki-Rea-Server gespeichert und sind am PC und auf dem Handy verfügbar.'),
    h('div', { class: 'card' }, drop),
    result,
    h(
      'div',
      { class: 'card' },
      h('h2', {}, 'Oder Liste einfügen'),
      h('p', { class: 'muted' }, 'Eine Karte pro Zeile. Wort und Übersetzung getrennt durch Tab, Semikolon oder „ - “. Eine dritte Spalte wird zum Beispielsatz.'),
      h('label', { class: 'field' }, h('span', {}, 'Vokabeln'), paste),
      h('label', { class: 'field' }, h('span', {}, 'Stapel'), pasteName),
      h(
        'button',
        {
          class: 'btn primary',
          onclick: () => {
            if (!paste.value.trim()) return toast('Bitte zuerst Vokabeln einfügen.', 'error');
            upload(new Blob([paste.value], { type: 'text/plain' }), `${pasteName.value.trim() || 'Eingefügte Vokabeln'}.txt`);
          },
        },
        'Vorschau anzeigen',
      ),
    ),
    h(
      'div',
      { class: 'card' },
      h('h2', {}, 'Export & Backup'),
      h('p', { class: 'muted' }, 'Das Backup enthält alle Karten samt Lernfortschritt und lässt sich hier wieder importieren. Der Text-Export kann auch in Anki importiert werden.'),
      h('label', { class: 'field' }, h('span', {}, 'Stapel'), exportSelect),
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'btn ghost', onclick: () => (location.href = exportLink('json')) }, icon('download'), 'Backup (JSON)'),
        h('button', { class: 'btn ghost', onclick: () => (location.href = exportLink('text')) }, icon('download'), 'Als Text (für Anki)'),
      ),
    ),
  );
}

// ---------- stats ----------

async function statsView(params) {
  const decks = await api('/decks');
  const deck = params.get('deck') || '';
  const s = await api(`/stats${deck ? `?deck=${deck}` : ''}`);
  const select = h(
    'select',
    { onchange: () => go(`#/stats${select.value ? `?deck=${select.value}` : ''}`), 'aria-label': 'Stapel' },
    h('option', { value: '' }, 'Alle Stapel'),
    decks.map((d) => h('option', { value: d.id }, d.name)),
  );
  select.value = deck;

  const st = s.states;
  const active = st.new + st.learning + st.young + st.mature || 1;
  const seg = (n, color) => h('div', { style: `width:${(n / active) * 100}%;background:${color}` });
  const legend = (label, n, color) => h('span', {}, h('i', { style: `background:${color}` }), `${label}: ${fmtNumber(n)}`);
  const bars = (items, labelFn, color) => {
    const max = Math.max(1, ...items.map((i) => i.count));
    return h(
      'div',
      { class: 'bars' },
      items.map((i, idx) =>
        h(
          'div',
          { class: 'bar', title: `${labelFn(i, idx, true)}: ${i.count}` },
          i.count ? h('em', {}, i.count) : null,
          h('div', { style: `height:${(i.count / max) * 100}%;${color ? `background:${color}` : ''}` }),
          h('small', {}, labelFn(i, idx, false)),
        ),
      ),
    );
  };
  const rate = s.today.reviews ? Math.round((s.today.correct / s.today.reviews) * 100) : null;

  view.replaceChildren(
    pageHead('Statistik', null),
    h('div', { class: 'toolbar' }, select),
    h(
      'div',
      { class: 'tiles' },
      h('div', { class: 'tile' }, h('b', {}, fmtNumber(s.today.reviews)), h('span', {}, 'heute gelernt')),
      h('div', { class: 'tile' }, h('b', {}, rate === null ? '–' : `${rate} %`), h('span', {}, 'heute gewusst')),
      h('div', { class: 'tile' }, h('b', {}, fmtNumber(s.streak)), h('span', {}, s.streak === 1 ? 'Tag in Folge' : 'Tage in Folge')),
      h('div', { class: 'tile' }, h('b', {}, fmtNumber(s.today.minutes)), h('span', {}, 'Minuten heute')),
    ),
    h(
      'div',
      { class: 'card' },
      h('h2', {}, 'Kartenstand'),
      h('div', { class: 'stack-bar' }, seg(st.new, 'var(--new)'), seg(st.learning, 'var(--learn)'), seg(st.young, 'var(--good)'), seg(st.mature, 'var(--review)')),
      h(
        'div',
        { class: 'legend' },
        legend('Neu', st.new, 'var(--new)'),
        legend('Lernen', st.learning, 'var(--learn)'),
        legend('Jung (< 21 Tage)', st.young, 'var(--good)'),
        legend('Sicher (≥ 21 Tage)', st.mature, 'var(--review)'),
        st.suspended ? legend('Ausgesetzt', st.suspended, 'var(--muted)') : null,
      ),
    ),
    h(
      'div',
      { class: 'card' },
      h('h2', {}, 'Fällig in den nächsten 14 Tagen'),
      bars(s.forecast, (i, idx, long) => (idx === 0 ? 'heute' : long ? `in ${idx} Tagen` : `+${idx}`), 'var(--review)'),
    ),
    h(
      'div',
      { class: 'card' },
      h('h2', {}, 'Wiederholungen der letzten 30 Tage'),
      bars(s.history, (i, idx, long) => {
        if (i.day === 0) return 'heute';
        const date = new Date(Date.now() + i.day * 86_400_000).toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric' });
        return long ? date : idx % 7 === 1 ? date : '';
      }),
      h('p', { class: 'muted' }, `Insgesamt ${plural(s.totalReviews, 'Wiederholung', 'Wiederholungen')}.`),
    ),
  );
}

// ---------- deck options ----------

const LANG_OPTIONS = [
  ['', 'Kein Vorlesen'],
  ['de-DE', 'Deutsch'],
  ['es-ES', 'Spanisch (Spanien)'],
  ['es-MX', 'Spanisch (Lateinamerika)'],
  ['en-US', 'Englisch (USA)'],
  ['en-GB', 'Englisch (UK)'],
  ['fr-FR', 'Französisch'],
  ['it-IT', 'Italienisch'],
  ['pt-PT', 'Portugiesisch'],
  ['pt-BR', 'Portugiesisch (Brasilien)'],
  ['nl-NL', 'Niederländisch'],
  ['sv-SE', 'Schwedisch'],
  ['pl-PL', 'Polnisch'],
  ['ru-RU', 'Russisch'],
  ['tr-TR', 'Türkisch'],
  ['ja-JP', 'Japanisch'],
  ['zh-CN', 'Chinesisch'],
];

async function deckOptionsView(id) {
  const d = await api(`/decks/${id}`);
  const c = d.config;
  const num = (value, attrs = {}) => h('input', { type: 'number', inputmode: 'numeric', value, ...attrs });
  const langSelect = (value) => {
    const s = h('select', {}, LANG_OPTIONS.map(([v, l]) => h('option', { value: v }, l)));
    s.value = value || '';
    return s;
  };
  const f = {
    name: h('input', { type: 'text', value: d.name }),
    frontLabel: h('input', { type: 'text', value: c.frontLabel }),
    backLabel: h('input', { type: 'text', value: c.backLabel }),
    extraLabel: h('input', { type: 'text', value: c.extraLabel }),
    frontLang: langSelect(c.frontLang),
    backLang: langSelect(c.backLang),
    autoplay: h('input', { type: 'checkbox', checked: c.autoplay }),
    bothDirections: h('input', { type: 'checkbox', checked: c.bothDirections }),
    newPerDay: num(c.newPerDay, { min: 0 }),
    reviewsPerDay: num(c.reviewsPerDay, { min: 0 }),
    learnSteps: h('input', { type: 'text', value: c.learnSteps.join(' ') }),
    relearnSteps: h('input', { type: 'text', value: c.relearnSteps.join(' ') }),
    graduatingIvl: num(c.graduatingIvl, { min: 1 }),
    easyIvl: num(c.easyIvl, { min: 1 }),
    startingEase: num(c.startingEase / 10, { min: 130, step: 5 }),
    maxIvl: num(c.maxIvl, { min: 1 }),
    deadline: h('input', { type: 'datetime-local', value: c.deadline ? toLocalInput(c.deadline) : '' }),
  };
  const quickDeadline = (label, days) =>
    h(
      'button',
      {
        type: 'button',
        class: 'chip',
        onclick: () => {
          const d = new Date();
          d.setDate(d.getDate() + days);
          d.setHours(8, 0, 0, 0);
          f.deadline.value = toLocalInput(d.getTime());
        },
      },
      label,
    );
  const field = (label, el, hint) => h('label', { class: 'field' }, h('span', {}, label), el, hint ? h('small', {}, hint) : null);

  async function save(e) {
    e.preventDefault();
    try {
      await api(`/decks/${id}`, {
        method: 'PATCH',
        body: {
          name: f.name.value,
          config: {
            frontLabel: f.frontLabel.value,
            backLabel: f.backLabel.value,
            extraLabel: f.extraLabel.value,
            frontLang: f.frontLang.value,
            backLang: f.backLang.value,
            autoplay: f.autoplay.checked,
            bothDirections: f.bothDirections.checked,
            newPerDay: f.newPerDay.value,
            reviewsPerDay: f.reviewsPerDay.value,
            learnSteps: f.learnSteps.value,
            relearnSteps: f.relearnSteps.value,
            graduatingIvl: f.graduatingIvl.value,
            easyIvl: f.easyIvl.value,
            startingEase: Number(f.startingEase.value) * 10,
            maxIvl: f.maxIvl.value,
            deadline: f.deadline.value ? new Date(f.deadline.value).getTime() : null,
          },
        },
      });
      toast('Einstellungen gespeichert');
      go('#/');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  view.replaceChildren(
    pageHead('Stapel-Optionen', d.name, h('a', { class: 'icon-btn', href: '#/', 'aria-label': 'Zurück' }, icon('back'))),
    h(
      'form',
      { onsubmit: save },
      h(
        'div',
        { class: 'card' },
        h('h2', {}, 'Prüfungstermin'),
        h(
          'p',
          { class: 'muted' },
          'Bis wann musst du die Vokabeln können? Anki Rea plant dann rückwärts: Neue Karten werden so verteilt, dass bis einen Tag vorher alle eingeführt sind, und keine Wiederholung liegt nach dem Termin – je näher er rückt, desto kürzer die Abstände (Tage → Stunden → Minuten).',
        ),
        field('Datum und Uhrzeit', f.deadline),
        h(
          'div',
          { class: 'chips' },
          quickDeadline('Morgen', 1),
          quickDeadline('In 3 Tagen', 3),
          quickDeadline('In 1 Woche', 7),
          quickDeadline('In 2 Wochen', 14),
          h('button', { type: 'button', class: 'chip', onclick: () => (f.deadline.value = '') }, 'Kein Termin'),
        ),
        c.deadline && c.deadline < Date.now() ? h('p', { class: 'notice warn' }, `Der Termin (${formatDeadline(c.deadline)}) ist vorbei – der normale Lernplan gilt wieder.`) : null,
      ),
      h(
        'div',
        { class: 'card' },
        h('h2', {}, 'Allgemein'),
        field('Name', f.name),
        h('div', { class: 'grid-2' }, field('Bezeichnung Vorderseite', f.frontLabel), field('Bezeichnung Rückseite', f.backLabel)),
        field('Bezeichnung Zusatzfeld', f.extraLabel),
        h('label', { class: 'check' }, f.bothDirections, 'In beide Richtungen lernen (auch Rückseite → Vorderseite)'),
      ),
      h(
        'div',
        { class: 'card' },
        h('h2', {}, 'Vorlesen'),
        h('div', { class: 'grid-2' }, field('Sprache Vorderseite', f.frontLang), field('Sprache Rückseite', f.backLang)),
        h('label', { class: 'check' }, f.autoplay, 'Automatisch vorlesen'),
        canSpeak() ? null : h('p', { class: 'muted' }, 'Dieser Browser unterstützt kein Vorlesen.'),
      ),
      h(
        'div',
        { class: 'card' },
        h('h2', {}, 'Tageslimits'),
        h('div', { class: 'grid-2' }, field('Neue Karten pro Tag', f.newPerDay), field('Wiederholungen pro Tag', f.reviewsPerDay)),
      ),
      h(
        'div',
        { class: 'card' },
        h('h2', {}, 'Lernplan (wie in Anki)'),
        h(
          'div',
          { class: 'grid-2' },
          field('Lernschritte (Minuten)', f.learnSteps, 'z. B. „1 10“'),
          field('Schritte nach Vergessen (Minuten)', f.relearnSteps, 'z. B. „10“'),
          field('Intervall nach „Gut“ (Tage)', f.graduatingIvl),
          field('Intervall nach „Einfach“ (Tage)', f.easyIvl),
          field('Startleichtigkeit (%)', f.startingEase, 'Anki-Standard: 250 %'),
          field('Maximales Intervall (Tage)', f.maxIvl),
        ),
      ),
      h('div', { class: 'row', style: 'margin-bottom:16px' }, h('a', { class: 'btn ghost', href: '#/' }, 'Abbrechen'), h('button', { class: 'btn primary', type: 'submit' }, 'Speichern')),
    ),
    h(
      'div',
      { class: 'card' },
      h('h2', {}, 'Stapel löschen'),
      h('p', { class: 'muted' }, `Löscht „${d.name}“ mit allen ${plural(d.counts.total, 'Karte', 'Karten')} und dem Lernfortschritt. Tipp: Vorher unter „Import“ ein Backup herunterladen.`),
      h(
        'button',
        {
          class: 'btn danger',
          onclick: async () => {
            if (!(await confirmDialog('Stapel wirklich löschen?', 'Das kann nicht rückgängig gemacht werden.', 'Endgültig löschen', true))) return;
            await api(`/decks/${id}`, { method: 'DELETE' });
            toast('Stapel gelöscht');
            go('#/');
          },
        },
        icon('trash'),
        'Stapel löschen',
      ),
    ),
  );
}

// ---------- boot ----------

for (const el of document.querySelectorAll('[data-icon]')) el.replaceWith(icon(el.dataset.icon));
window.addEventListener('hashchange', () => {
  loginShown = false;
  render();
});
if (canSpeak()) speechSynthesis.getVoices();
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
render();
