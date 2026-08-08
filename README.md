# MyTube

Ein privater YouTube-Feed für das iPad. Keine Shorts, nichts älter als N Tage,
kein Empfehlungsalgorithmus.

**Die App hat keinen Server.** Alles läuft auf dem iPad: die YouTube-Anfragen,
die optionale KI-Bewertung, die Datenbank. Gehostet wird nur eine statische
Seite — kostenlos, und es gibt nichts, was im Urlaub ausfallen könnte.

---

## Warum dein YouTube-Account sicher ist

Die App benutzt ausschließlich die offizielle **YouTube Data API v3 mit einem
API-Key** — kein OAuth, kein Login, keine Cookies, keine Stream-Extraktion,
kein Scraping. Dein Google-Konto ist an keiner Stelle beteiligt und kann durch
diese App nicht gesperrt werden.

Gesperrt werden könnte höchstens das *API-Projekt*, und auch das nur bei
Quota-Missbrauch. Ein Lauf über 61 Kanäle verbraucht **78 von 10.000
Einheiten** pro Tag (0,8 %).

Abgespielt wird über den offiziellen `youtube-nocookie`-Player oder direkt in
der YouTube-App. Keine eigenen Bedienelemente über dem Player, kein Adblock,
kein Hintergrund-Audio — die Required Minimum Functionality wird eingehalten.

---

## Einrichtung (einmalig, ~15 Minuten)

### 1. YouTube-API-Key

1. [console.cloud.google.com](https://console.cloud.google.com) → neues Projekt
2. **APIs & Dienste → Bibliothek** → „YouTube Data API v3" → **Aktivieren**
3. **Anmeldedaten → Anmeldedaten erstellen → API-Schlüssel**
4. Auf **API-Beschränkung: YouTube Data API v3** setzen.
   Das ist der Schutz, der zählt: Selbst wenn der Key jemandem in die Hände
   fällt, kann er nur deine Quota verbrauchen — die sich täglich zurücksetzt.

> **Anwendungsbeschränkung:** Wenn überhaupt, dann **„Websites" (HTTP-Referrer)**
> mit `https://DEINNAME.github.io/*`. **Nicht** „iOS-Apps" — die Bundle-ID
> funktioniert nur für native Apps mit Googles SDK; eine Webseite sendet keine,
> und Google würde jeden Request ablehnen. Setz die Beschränkung und teste
> sofort. Wenn es nicht läuft: zurück auf „Keine".

Kein OAuth-Client, kein Zustimmungsbildschirm, keine Verifizierung.

### 2. Abo-Liste exportieren

[takeout.google.com](https://takeout.google.com) → alles abwählen → nur
**YouTube und YouTube Music** → *Alle Daten einbeziehen* → nur **Abos** →
exportieren. Du bekommst eine `Abos.csv` mit Kanal-IDs.

### 3. Veröffentlichen

Die App ist eine statische Seite. GitHub Pages reicht:

```bash
gh repo create mytube --public --source=. --push
gh api -X POST repos/:owner/mytube/pages -f 'source[branch]=main' -f 'source[path]=/'
```

Nach ein bis zwei Minuten liegt sie unter `https://DEINNAME.github.io/mytube/`.

> Im Repository stehen **keine Geheimnisse**. Der API-Key und deine Abo-Liste
> liegen unter `Google/` und sind per `.gitignore` ausgeschlossen. Prüfe vor dem
> ersten Push einmal `git status`.

### 4. Auf dem iPad einrichten

1. Adresse in **Safari** öffnen
2. Teilen → **Zum Home-Bildschirm**
3. **Ab jetzt nur noch die Home-Bildschirm-App benutzen.** Safari und die
   Home-Bildschirm-App teilen ihren Speicher nicht — was du in Safari
   einträgst, kennt die App nicht.
4. In der App: **Einstellungen** → API-Key eintragen → speichern
5. **Kanäle** → `Abos.csv` laden → *Importieren*. Zwei Wege:
   - **CSV-Datei wählen** — greift auf „Dateien" und iCloud Drive. Schick dir
     die `Abos.csv` einmal per AirDrop aufs iPad, dann brauchst du den Mac nie
     wieder dafür.
   - **Einfügen** — auf dem Mac `pbcopy < Abos.csv`, dann per Universal
     Clipboard direkt auf dem iPad ins Textfeld einsetzen.
6. Oben rechts **Aktualisieren**

---

## KI-Bewertung (optional)

Ohne sie läuft der Feed chronologisch — das löst „keine alten Videos, keine
Shorts" bereits vollständig. Die KI beantwortet eine andere Frage: *Was davon
lohnt sich?*

Dafür einen Key von [console.anthropic.com](https://console.anthropic.com) in
den Einstellungen eintragen, **KI-Bewertung** einschalten und die Sortierung auf
**KI-Ranking** stellen. Im **Manifest** beschreibst du in eigenen Worten, was du
sehen willst; unter jedem Video steht dann ein Satz, warum es vorgeschlagen wird.

**Kosten** mit Claude Haiku 4.5: rund **1 Cent pro 25 bewertete Videos**. Bei
30–50 neuen Videos am Tag sind das ~2 Cent täglich. In den Einstellungen gibt es
ein Tagesbudget mit hartem Stop.

---

## Vor der Abreise abhaken

- [ ] API-Key eingetragen, **Aktualisieren** einmal erfolgreich gelaufen
- [ ] Kanäle importiert, Feed zeigt Videos
- [ ] Ein Video abgespielt (Player *und* „In YouTube öffnen")
- [ ] Wenn KI aktiv: einmal laufen lassen und prüfen, dass Scores erscheinen
- [ ] **Einstellungen → Sicherung laden** und die Datei in iCloud ablegen
- [ ] Falls du eine Referrer-Beschränkung gesetzt hast: läuft die App noch?

---

## Wenn unterwegs etwas klemmt

| Symptom | Ursache | Lösung |
|---|---|---|
| „API key not valid" | Referrer-Beschränkung greift | In der Cloud Console Anwendungsbeschränkung auf „Keine" |
| „Tages-Quota erschöpft" | > 10.000 Einheiten | Bis morgen warten; „Videos pro Kanal je Lauf" senken |
| Feed leer | Alle gesehen/gefiltert | Alterslimit erhöhen oder Mindestdauer senken |
| Player schwarz | Uploader verbietet Einbetten | „In YouTube öffnen" — steht immer daneben |
| Werbung trotz Premium | Third-Party-Cookies im Embed | „In YouTube öffnen" — dort greift Premium |
| App zeigt alte Fassung | Service Worker cached | Einstellungen → **Neu laden erzwingen** |

**Der Notausgang:** Weil alles auf GitHub liegt, kannst du jede Datei direkt im
Browser auf github.com bearbeiten — auch vom iPad. Nach dem Speichern deployt
sich die Seite neu. Das kannst du mit keinem Server.

---

## Grenzen, die du kennen solltest

- **Premium wirkt im eingebetteten Player wahrscheinlich nicht.** WebKit blockt
  Third-Party-Cookies, YouTube erkennt dein Abo nicht. Für lange Videos ist
  „In YouTube öffnen" ohnehin der bessere Weg — dort funktionieren Premium,
  Hintergrund-Audio, PiP und AirPlay.
- **Kein Hintergrund-Audio, kein PiP** im Embed. Technisch gesperrt und
  vertraglich verboten.
- **Kein nächtlicher Vorlauf.** Beim ersten Öffnen am Tag synct die App ~10
  Sekunden. Das ist der Preis dafür, dass es keinen Server gibt.
- **Der Zustand lebt auf dem iPad.** Deshalb die Sicherung.
- **`UULF` ist undokumentiert.** Verschwindet das Präfix, schaltet die App
  automatisch auf `UU` + `UUSH`-Ausschluss um und meldet das im Status.

---

## Aufbau

```
index.html            Schale
css/style.css
js/main.js            Router, Ansichten, Feed, Player
js/db.js              IndexedDB
js/settings.js        Einstellungen, Manifest
js/youtube.js         Data API — Kanäle, Playlists, Metadaten
js/ai.js              Claude-Bewertung, Kostenzähler
js/rank.js            Stufe-0-Filter, Ranking (MMR + Exploration)
js/sync.js            Ablauf eines Laufs
js/anthropic.js       Anthropic SDK, gebündelt (kein CDN zur Laufzeit)
sw.js                 Offline-Schale
```

`js/anthropic.js` ist das offizielle `@anthropic-ai/sdk` (v0.116.0), mit esbuild
für den Browser gebündelt. Bewusst mitgeliefert statt vom CDN geladen: keine
Laufzeit-Abhängigkeit, funktioniert offline, keine Überraschungen unterwegs.
