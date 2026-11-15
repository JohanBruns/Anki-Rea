# Anki Rea

Ein schlanker Nachbau von Anki als Web-App – große Buttons, wenig Verschachtelung, nutzbar am PC und auf dem Handy.

## Starten

Doppelklick auf **`start.bat`** – oder im Terminal:

```bash
npm start
```

Dann im Browser: <http://localhost:8420>. Das Server-Fenster zeigt auch die Adresse fürs Handy (z. B. `http://192.168.178.20:8420`).

Voraussetzung: Node.js ab Version 24.15 (es werden keine weiteren Pakete installiert).

## Online stellen (Vercel) – fürs Handy, überall

Online läuft Anki Rea auf Vercel mit einer Postgres-Datenbank (Neon) und ist per Passwort geschützt. Der PC muss dafür nicht laufen.

1. **Anmelden und erstes Deployment** (fragt nach Projektname usw. – Standardwerte passen):
   ```bash
   npx vercel@65.9.0 login
   npx vercel@65.9.0
   ```
2. **Datenbank anlegen:** Im Vercel-Dashboard → Projekt *anki-rea* → **Storage** → **Create Database** → **Neon (Postgres)**, Region **Frankfurt**, mit dem Projekt verbinden. Das setzt `DATABASE_URL` automatisch.
3. **Passwort festlegen** (wird abgefragt, nicht angezeigt):
   ```bash
   npx vercel@65.9.0 env add ANKI_REA_PASSWORD production
   ```
4. **Produktiv veröffentlichen:**
   ```bash
   npx vercel@65.9.0 --prod
   ```
5. **Vokabeln samt Lernstand hochladen:** lokal unter *Import → Backup (JSON)* herunterladen, online anmelden und die Datei unter *Import* hochladen – „Lernfortschritt übernehmen“ angehakt lassen.
   (Vercel gibt die Datenbank-Zugangsdaten nicht an den PC heraus. Wer `npm run push-cloud` nutzen will, trägt `DATABASE_URL` aus dem Neon-Dashboard selbst in `.env.local` ein.)
6. **Auf dem Handy:** die `https://…vercel.app`-Adresse öffnen, anmelden, dann
   - **Android/Chrome:** Menü ⋮ → **„App installieren“** bzw. „Zum Startbildschirm hinzufügen“
   - **iPhone/Safari:** Teilen → **„Zum Home-Bildschirm“**

   Anki Rea startet dann im Vollbild wie eine App und bleibt angemeldet.

Lokal (`npm start`) läuft weiter mit der SQLite-Datei – oder mit der Online-Datenbank, wenn `DATABASE_URL` gesetzt ist.

## Im Heim-WLAN (ohne Online-Hosting)

1. PC und Handy im **gleichen WLAN**, Anki Rea läuft auf dem PC.
2. Am Handy die im Server-Fenster angezeigte Adresse öffnen.

Beim ersten Start fragt die Windows-Firewall, ob Node.js im Netzwerk erreichbar sein darf: **„Private Netzwerke“ erlauben**. Ohne HTTPS ist das nur eine Verknüpfung, keine installierbare App.

## Vokabeln hochladen

Unter **Import** (oder per Drag & Drop) werden diese Formate erkannt:

| Format | Beispiel |
| --- | --- |
| Anki-Paket | `.apkg`, `.colpkg` – inkl. Lernfortschritt |
| Excel | `.xlsx` (erstes Tabellenblatt) |
| Text / CSV | `Wort<Tab>Übersetzung`, `Wort;Übersetzung`, `Wort - Übersetzung` |
| JSON | Anki-Rea-Backup oder Liste `[{"front": …, "back": …}]` |

Eine dritte Spalte wird zum Beispielsatz. Eine Kopfzeile wie `Deutsch;Spanisch` wird erkannt und als Feldname sowie für die Vorlese-Sprache verwendet. Doppelte Karten werden beim erneuten Hochladen übersprungen.

Die Vokabeln aus der lokalen Anki-Installation (mit Lernstand) holt:

```bash
npm run import-anki
```

## Lernen

- Antwort zeigen: auf die Karte tippen oder **Leertaste**
- Bewerten: **Nochmal / Schwer / Gut / Einfach** oder Tasten **1–4** (Leertaste = Gut)
- **Z** rückgängig, **E** bearbeiten, **R** vorlesen, **Esc** zurück
- **Weiterlernen:** Sind alle Karten für heute geschafft, geht es mit einem Tipp sofort weiter – zuerst die Karten, die als Nächstes fällig wären, heute schon gesehene zuletzt, danach neue Karten. Die Sitzung endet erst, wenn du sie verlässt. Vorzeitiges Wiederholen verkürzt den geplanten Abstand nie (wie Ankis „Vorauslernen“).

### Prüfungstermin (Deadline)

In den Stapel-Optionen lässt sich ein Termin festlegen, bis zu dem alle Vokabeln sitzen müssen. Dann gilt:

- **Neue Karten** werden so verteilt, dass sie bis einen Tag vor dem Termin alle eingeführt sind (das eingestellte Tageslimit wird bei Bedarf erhöht).
- **Keine Wiederholung liegt nach dem Termin:** Der nächste Abstand ist höchstens die Hälfte der verbleibenden Zeit. Statt „in 14 Tagen“ heißt es bei 5 Stunden Restzeit „in 2,5 Std“ – je näher der Termin, desto kürzer die Abstände.
- Das Wiederholungs-Limit pro Tag entfällt; die Übersicht zeigt Fortschritt („46 von 70 gelernt“) und wie viele neue Karten heute noch dran sind.
- Nach dem Termin läuft der normale Lernplan mit den langen Intervallen weiter.

Der Lernplan entspricht Ankis Standard-Algorithmus (SM-2, v3-Scheduler): Lernschritte 1 und 10 Minuten, Startleichtigkeit 250 %, Tageswechsel um 4 Uhr. Alles ist pro Stapel unter den Stapel-Optionen einstellbar – ebenso „In beide Richtungen lernen“ und automatisches Vorlesen.

## Daten & Backup

Alles liegt in `data/anki-rea.db` (SQLite). Unter **Import → Export & Backup** gibt es ein vollständiges JSON-Backup (mit Lernfortschritt) und einen Text-Export, den auch das Original-Anki importieren kann.

## Entwicklung

```bash
npm test
npm run test:pg
```

`test:pg` führt die Datenbank-Tests gegen echtes Postgres aus (PGlite, ohne Docker).

| Ordner | Inhalt |
| --- | --- |
| `server/` | HTTP-Server, API, Scheduler, Datenbank-Adapter (SQLite/Postgres), Login |
| `api/` | Einstiegspunkt für Vercel |
| `server/importers/` | Anki-, Excel-, Text- und JSON-Import |
| `public/` | Web-Oberfläche (ohne Build-Schritt) |
| `scripts/` | Anki-Import, Icon-Generator |
| `test/` | Tests (`node --test`) |

Umgebungsvariablen: `PORT` (Standard 8420), `HOST` (Standard 0.0.0.0), `ANKI_REA_DB` (Pfad zur SQLite-Datei), `DATABASE_URL` (Postgres statt SQLite), `ANKI_REA_PASSWORD` (aktiviert den Login), `ANKI_REA_SECRET` (optional, zusätzlicher Schlüssel für das Login-Cookie).

### Wie Anki analysiert wurde

Grundlage war die installierte Anki-Version 26.9 (Analyse mit REA):

- **Sammlung** (`collection.anki2`, SQLite): Schema der Tabellen `notes`, `cards`, `revlog`, `decks`, `deck_config`, `notetypes`, `fields`, `templates`. Die Stapel-Einstellungen sind Protobuf-kodiert und wurden daraus dekodiert (Lernschritte, Leichtigkeit, Faktoren, Limits).
- **Lern-Ansicht** (`aqt/reviewer.pyc`, `reviewer*.js`): Ablauf Frage → Antwort → vier Bewertungen mit Intervall-Vorschau, Rückgängig, Aussetzen, Bearbeiten.
- Anki markiert Namensspalten mit einer eigenen Sortierung (`unicase`), die SQLite außerhalb von Anki nicht kennt. Der Import entfernt sie deshalb in einer temporären Kopie – die echte Anki-Sammlung wird nie verändert.

Bewusst weggelassen: Bilder/Audio in Karten, Lückentext mit mehreren Lücken pro Karte, Bildverdeckung, FSRS, AnkiWeb-Synchronisierung.
