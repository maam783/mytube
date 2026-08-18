# MyTube — Architektur und Entscheidungen

Dieses Dokument beschreibt, **wie** die App gebaut ist und **warum** sie so
gebaut ist. Die Bedienungsanleitung steht im [README](README.md); der
ursprüngliche Konzeptentwurf in [PRIVATETUBE_IPAD.md](PRIVATETUBE_IPAD.md) ist
historisch und in Teilen überholt (die App hieß damals noch PrivateTube).

---

## 1. Der Auftrag und die vier harten Randbedingungen

Der Auslöser: YouTube empfiehlt Videos, die drei Jahre alt sind, und Shorts.
Gesucht war ein Ersatz für die YouTube-App auf dem iPad, der nur zeigt, was
neu ist und interessiert.

Vier Randbedingungen wurden vorgegeben, und sie haben praktisch jede
Architekturentscheidung determiniert:

| Randbedingung | Was daraus folgt |
|---|---|
| **Der YouTube-Account darf nicht gefährdet werden** | Kein OAuth, kein Login, keine Cookies, keine Stream-Extraktion, kein Scraping. Nur die offizielle Data API v3 mit API-Key. |
| **Muss ohne Mac laufen, nur auf dem iPad, unterwegs** | Kein Server, kein Backend, kein Heim-NAS. Alles läuft im Browser des Geräts. |
| **Darf nichts kosten außer kleinen KI-Calls** | Statisches Hosting auf GitHub Pages. Keine Datenbank, kein Dienst, kein Abo. |
| **Muss robust laufen, auch im Hotel-WLAN und im Ausland** | Offline-Schale per Service Worker, Backoff bei Netzfehlern, harte Quota-Buchhaltung, jeder Fehlschlag darf nur sich selbst brechen. |

Der wichtigste Satz zur Architektur lautet deshalb: **Es gibt keinen Server.**
Nicht „der Server ist klein", sondern es gibt keinen. Alles, was passiert,
passiert im Browser auf dem Gerät — die YouTube-Anfragen, die KI-Bewertung, die
Datenbank, die Verschlüsselung. Gehostet wird eine Handvoll statischer Dateien.

Das ist keine Askese, sondern Betriebssicherheit: Was es nicht gibt, kann im
Urlaub nicht ausfallen. Der Preis dafür steht ehrlich unter „Grenzen" im README
(kein nächtlicher Vorlauf, der Zustand lebt auf dem Gerät).

---

## 2. Überblick

```
index.html            Schale, Nav-Tabs
css/style.css   705   Editorial-Layout „Die Tagesausgabe"
js/main.js     1837   Router, alle Ansichten, Feed, Player, Gesten
js/db.js        141   IndexedDB-Schicht
js/settings.js   95   Einstellungen + Manifest, mit Defaults
js/youtube.js   340   Data API: Kanäle, Playlists, Metadaten, Suche, Quota
js/ai.js        256   Claude-Bewertung, Structured Outputs, Kostenzähler
js/rank.js      169   Stufe-0-Filter und Ranking
js/sync.js      287   Ablauf eines kompletten Laufs
js/cloudsync.js 263   Verschlüsselter Geräteabgleich über GitHub
js/anthropic.js  41   Anthropic SDK, gebündelt (kein CDN zur Laufzeit)
sw.js            89   Offline-Schale
```

Vanilla JavaScript, ES-Module, **kein Framework und kein Build-Schritt**. Die
einzige Ausnahme ist `js/anthropic.js`: das offizielle `@anthropic-ai/sdk`
(v0.116.0), einmalig mit esbuild für den Browser gebündelt und mitgeliefert.
Bewusst nicht vom CDN geladen — eine Laufzeit-Abhängigkeit, die im Hotel-WLAN
nicht auflöst, wäre genau die Sorte Überraschung, die es nicht geben darf.

Kein Build-Schritt heißt außerdem: Jede Datei lässt sich direkt auf github.com
im Browser bearbeiten, auch vom iPad. Nach dem Speichern deployt sich die Seite
neu. Das ist der Notausgang unterwegs.

---

## 3. Datenfluss — was bei „Aktualisieren" passiert

`js/sync.js` `run()` ist der einzige Ort, an dem Daten hereinkommen. Der Ablauf
in sechs Schritten:

```
1. Kanäle laden          channels-Store, nur active !== false
2. Neue Video-IDs        pro Kanal die UULF-Playlist, parallel (concurrency)
3. Metadaten             videos.list für alle neuen IDs, in 50er-Blöcken
   └ Alterslimit greift SCHON HIER: zu Altes landet gar nicht in der DB
   └ Shorts-Erkennung dreistufig, siehe unten
4. Entdecken (optional)  search.list für die Themen, Cursor wandert über Tage
5. Aufräumen             zu alte Videos und Waisen entfernen
6. KI-Bewertung          Claude scored unbewertete Videos, 3 Batches parallel
```

Nach Schritt 5 wird der Feed bereits gerendert — die KI-Bewertung läuft danach
weiter und aktualisiert die Anzeige, wenn sie fertig ist. Grund: Die Bewertung
war die mit Abstand langsamste Phase, und minutenlang auf einen leeren Bildschirm
zu starren, während die Daten längst da sind, ist kein akzeptables Verhalten.

Der ganze Lauf hängt an einem `AbortController`. Ein zweiter Klick auf
„Aktualisieren" bricht ab, statt ein No-Op zu sein.

### Der UULF-Trick

Aus einer Kanal-ID `UC…` lassen sich drei Playlist-IDs ableiten:

| Präfix | Inhalt |
|---|---|
| `UU…` | alle Uploads |
| `UULF…` | **nur Langform** (keine Shorts) |
| `UUSH…` | nur Shorts |

`UULF`/`UUSH` sind **undokumentiert**. Sie wurden empirisch geprüft: null
Überlappung zwischen beiden Listen, zusammen ergeben sie `UU`. Das ist die
sauberste Shorts-Filterung überhaupt — Shorts kommen gar nicht erst an.

Weil undokumentiert auch „kann jederzeit verschwinden" heißt, gibt es einen
Fallback: Schlägt `UULF` fehl, schaltet `fetchNewVideoIds()` auf `UU` plus
Ausschluss der `UUSH`-Liste um, markiert den Kanal mit `playlistMode: 'uploads'`
und **meldet das sichtbar im Status**. Nur für diese Kanäle greift dann
zusätzlich die Dauer-Heuristik.

Deshalb ist Shorts-Erkennung dreistufig, und die Ebenen sind bewusst nicht
gleichwertig ([rank.js:20](js/rank.js:20)):

1. Playlist-Quelle (trägt normalerweise allein)
2. `#shorts` in Titel oder Beschreibung
3. Dauer unter der Shorts-Grenze — **nur** wenn Ebene 1 versagt hat

Ebene 3 pauschal anzuwenden wäre falsch: Ein legitimes 2-Minuten-Video wäre
dann fälschlich ein „Short". Dafür ist die Mindestdauer zuständig, und die sagt
dem Nutzer dann auch ehrlich, warum das Video fehlt.

### Quota

| Aufruf | Kosten |
|---|---|
| `playlistItems`, `videos`, `channels` | 1 Einheit |
| `search` | **100 Einheiten** |

Tageskontingent: 10.000. Ein Lauf über 61 Kanäle kostet **78 Einheiten** (0,8 %).
Die Suche ist hundertmal teurer als alles andere — deshalb ist „Entdecken"
standardmäßig aus, hat ein eigenes Tageslimit, und pro Suche werden immer 50
Treffer geholt statt 15: **gleicher Preis, dreifache Ausbeute.**

`js/youtube.js` führt rein lokal Buch (`kv`-Store, Tagesschlüssel), damit die
Anzeige stimmt. Verlässlich ist ohnehin nur Googles eigene Zählung — die lokale
dient der Diagnose unterwegs.

---

## 4. Datenmodell

IndexedDB, vier Stores:

| Store | Schlüssel | Indizes | Inhalt |
|---|---|---|---|
| `videos` | `id` | `byChannel`, `byPublished` | Metadaten **und** Zustand (`watched`, `dismissed`, `saved`, `savedAt`, `rating`, `score`, `reason`, `source`) |
| `channels` | `id` | — | Titel, `active`, `weight`, `playlistMode`, `lastPolledAt`, `lastStatus` |
| `feedback` | `id` (autoIncrement) | `byVideo` | Bewertungshistorie für die KI-Beispiele |
| `kv` | `k` | — | Einstellungen, Manifest, Quota, Blockliste, Sync-Zustand, `deviceId` |

> **Der Datenbankname ist `privatetube`, nicht `mytube`.** Das ist Absicht:
> IndexedDB kennt kein Umbenennen. Ein neuer Name wäre eine neue, leere
> Datenbank — alle Kanäle, Einstellungen und Bewertungen blieben in der alten
> liegen. Der Name ist nirgends sichtbar, das Risiko lohnt nicht.
> Siehe [db.js:3](js/db.js:3).

---

## 5. Filtern und Sortieren

### Stufe 0 — kostenlos, läuft bei jedem Render

`stage0Reject()` ([rank.js:44](js/rank.js:44)) gibt für jedes Video **den Grund
zurück, warum es nicht im Feed steht** — oder `null`. Kein `boolean`: Die Gründe
werden gezählt und unter dem Feed angezeigt („5 ausgefiltert — Details im
Status"). Ein Filter, der nicht sagen kann warum, ist unterwegs nicht zu
diagnostizieren.

Die Prüfungen laufen bei **jedem Render** neu, nicht beim Sync. Dadurch greift
eine geänderte Einstellung sofort, ohne neuen API-Aufruf — und Videos, die
gerade an der Aufruf-Hürde scheitern, tauchen später von selbst auf, wenn sie
genug Aufrufe gesammelt haben.

### Ranking

**„Neueste zuerst"** ist strikt chronologisch und löst das ursprüngliche Problem
bereits vollständig. Die KI beantwortet eine andere Frage: *Was davon lohnt sich?*

**„KI-Ranking"** rechnet pro Video:

```
base = Score/100 × exp(−Alter/Halbwertszeit) × Kanalgewicht × Beliebtheit
```

Die Beliebtheit geht logarithmisch ein (`1 + Gewicht × log₁₀(1+Aufrufe)/7`),
damit ein Millionen-Video nicht alles totschlägt: 100.000 ergibt ~1,36, eine
Million ~1,43.

Danach zwei Korrekturen ([rank.js:112](js/rank.js:112)):

- **MMR-artige Kanalstrafe:** Jedes weitere Video desselben Kanals wird mit
  `0,6^n` multipliziert. Ohne das belegt ein produktiver Lieblingskanal die
  halbe Seite.
- **Exploration-Slots:** Jede 10. Position kommt aus dem Mittelfeld
  (Score 40–70). Ein Ranker, der nur seine eigene Überzeugung bestätigt, wird
  über die Zeit immer enger.

---

## 6. Die KI-Bewertung

Claude Haiku 4.5 wird **direkt aus dem Browser** aufgerufen — es gibt ja keinen
Server, der den Key verstecken könnte. Nötig dafür ist
`dangerouslyAllowBrowser: true` beim Anlegen des Clients — das SDK setzt
daraufhin selbst den Header `anthropic-dangerous-direct-browser-access: true`,
ohne den die API den Aufruf aus dem Browser ablehnt.

Das ist vertretbar, weil der Key dem Nutzer selbst gehört, sein Gerät nie
verlässt (außer verschlüsselt beim Geräteabgleich) und ein Tagesbudget mit
hartem Stop dahinter liegt.

Die Bewertung nutzt **Structured Outputs** (`output_config` mit `json_schema`),
nicht Prompt-Engineering auf JSON-Format. Das Modell bekommt das Manifest, ein
paar der letzten echten Bewertungen als Beispiele und eine Liste Videos; zurück
kommen Score und ein Satz Begründung, der unter dem Video steht.

**Kosten:** rund 1 Cent pro 25 bewertete Videos, also ~2 Cent am Tag.

---

## 7. Der Geräteabgleich

Das Problem: Die App läuft auf Mac, iPad und iPhone — mit je eigener
IndexedDB. Was auf dem iPad weggeräumt wurde, war auf dem Mac noch da.

Die Lösung ohne Server: **ein privates GitHub-Repo als Ablage für genau eine
Datei**, clientseitig verschlüsselt.

```
buildSnapshot()  →  merge(lokal, remote)  →  applySnapshot()  →  encrypt  →  PUT
```

- **Verschlüsselung:** AES-256-GCM, Schlüssel per PBKDF2 (150.000 Iterationen,
  SHA-256) aus einem frei gewählten Sync-Passwort. GitHub sieht ausschließlich
  Zufallsbytes — nachgemessen, weder Kanalnamen noch Videotitel noch der
  API-Key stehen im Klartext in der Datei. **Deshalb** dürfen die API-Keys
  mitwandern, und genau das macht den Punkt der Übung aus: einmal einrichten,
  überall fertig.
- **Nebenläufigkeit:** Die GitHub Contents API liefert zu jeder Datei ein `sha`
  und lehnt ein `PUT` mit veraltetem `sha` ab (409). Das ist optimistische
  Sperrung, geschenkt. Die App zieht dann neu, führt zusammen und schiebt
  erneut — einmal, dann Fehlermeldung.
- **Token:** fine-grained, auf genau ein Repo beschränkt, einzige Berechtigung
  `Contents: Read and write`. Ein geleaktes Token kann damit nichts außer dieser
  einen Datei.

Zusammenführungsregeln ([cloudsync.js:149](js/cloudsync.js:149)):

| | Regel | Warum |
|---|---|---|
| Einstellungen, Manifest, Kanäle | letzter Schreiber gewinnt | Skalare, keine sinnvolle Verschmelzung |
| API-Keys | leerer Wert überschreibt **nie** | sonst löscht ein frisch eingerichtetes Gerät die Keys der anderen |
| Gesehen / Ausgeblendet | **ODER** | einmal irgendwo weggeräumt heißt überall weg — das ist der eigentliche Zweck |
| Merkliste | Vereinigung nach ID | „später ansehen" darf nicht verloren gehen |
| Bewertungen | jüngster Zeitstempel | Historie, kein Zustand |

`syncRepo`, `syncToken` und `syncPass` wandern bewusst **nicht** mit — Henne-Ei:
ohne sie gäbe es keinen Abgleich. Die tippt man pro Gerät einmal ein.

---

## 8. Das Feed-Design

Die erste Fassung war eine technische Liste — funktional, aber unschön. Der
Neuentwurf entstand über einen Multi-Agent-Workflow: Red-Team-Kritik am
Bestehenden, drei unabhängige Entwürfe parallel, Jury-Synthese.

Das Ergebnis heißt **„Die Tagesausgabe"** und arbeitet mit einem einzigen
visuellen Gefälle, einmal von oben:

```
Aufmacher (Hero)  →  vier Karten  →  einheitliche Zeilen
```

darunter Abschnitte nach Tag: **Heute · Gestern · Diese Woche · Älter**, in
fester Reihenfolge.

Interaktionen:

- **Wischen** zum Wegräumen (Pointer Events, mit Undo-Leiste statt `confirm()`)
- **Langes Drücken / „···"** öffnet ein Menü — Popover auf dem Desktop,
  Bottom-Sheet auf dem Handy
- **Scrollposition pro Route** wird gemerkt (`history.scrollRestoration = 'manual'`
  plus eigene Map)

### Die vier Wege, ein Video wegzuräumen

Das ist die inhaltlich wichtigste Designentscheidung der ganzen App:

| | Signal an den Filter | Zeile |
|---|---|---|
| 👍 Mehr davon | `+1` | **bleibt** — man will es ja noch sehen |
| 👎 Weniger davon | `−1` | verschwindet |
| ✕ Ausblenden | **keins** | verschwindet |
| 🔖 Merken | keins | wandert in die Merkliste |
| ✓ Gesehen | **keins** | verschwindet |

Der Unterschied zwischen 👎 und *Ausblenden* ist der Punkt. Ursprünglich schrieb
„Ausblenden" ein negatives Feedback (`−0,3`). Das war falsch: Wer sein Postfach
leerräumt, bringt dem Filter damit bei, dass er seine eigenen Abos nicht mag.
Und es fehlte der Fall „der Kanal ist gut, aber dieses eine Automodell
interessiert mich nicht" — dafür ist eine Wertung schlicht die falsche
Sprache.

Jede der Aktionen wurde durch Zählen der `feedback`-Einträge davor und danach
verifiziert: 0, 0, 1 — nicht angenommen, gemessen.

---

## 9. Fallen, die wir gefunden haben

Diese Liste ist der eigentliche Wert des Dokuments. Jeder Punkt hat echte Zeit
gekostet.

### Der Service Worker fror veraltete Dateien dauerhaft ein

**Das gefährlichste Problem des Projekts.** GitHub Pages sendet
`Cache-Control: max-age=600`. Der HTTP-Cache des Browsers lieferte dem Service
Worker deshalb auch bei einem frischen `fetch()` eine alte Antwort — und der SW
cachte diese alte Antwort dann **dauerhaft**.

Wirkung: Jede künftige Fehlerbehebung hätte das Gerät nie erreicht. Der Fehler
tarnt sich als „die Behebung hat nicht funktioniert".

Behebung: `{ cache: 'no-cache' }` an allen `fetch()`-Aufrufen in `sw.js`,
erzwingt Revalidierung gegen den Ursprung. Zusätzlich behandelt der SW jetzt
Nicht-2xx-Antworten als Fehlschlag statt eine 404-Seite als gültigen Inhalt zu
cachen.

### `requestAnimationFrame` feuert in Hintergrund-Tabs nie

Betraf drei Stellen: Scroll-Wiederherstellung, Einblenden der Undo-Leiste,
Einblenden des Bottom-Sheets. Das Muster
„`requestAnimationFrame` → Klasse setzen → CSS-Transition" ist schlicht unsicher.

Ersetzt durch synchrones `void element.offsetHeight` (erzwingt Reflow) und
unmittelbar danach die Klassenänderung. Für die Scroll-Wiederherstellung
zusätzlich ein `setTimeout(…, 60)` hinterher, weil die native
History-Wiederherstellung des Browsers sonst asynchron darüberbügelt.

### `node --check` prüft ES-Module nicht richtig

Ein überzähliges Komma in einem verschachtelten Ternary in `cloudsync.js` war
als klassisches Skript gültig, als ES-Modul aber ein `SyntaxError`. `node --check`
meldete nichts. Der Import wäre im Browser lautlos gescheitert — das ganze
Sync-Feature wäre tot gewesen, ohne dass irgendetwas eine Fehlermeldung zeigt.

**Methodik ab jetzt:** Syntaxprüfung mit
`node --input-type=module --eval "$(cat datei.js)"`. Das parst strikt als ESM,
so wie der Browser es auch tut.

### Sicherung einspielen hatte nie funktioniert

`{ ...f, id: undefined }` sieht aus wie „ohne id", ist es aber nicht: Die
Eigenschaft ist vorhanden und trägt `undefined`. IndexedDB hält das für einen
ungültigen Schlüssel und **bricht die ganze Transaktion ab**. Jede Sicherung,
die je eingespielt wurde, war stillschweigend fehlgeschlagen.

Behebung: echtes Weglassen per Destructuring
(`const { id, ...ohneId } = f; return ohneId;`). Gefunden beim eigenen Testen,
nicht durch eine Fehlermeldung — die gab es nämlich nicht.

### Die Maus wischte beim bloßen Drüberfahren

Der `pointermove`-Handler verarbeitete Bewegungen, ohne zu prüfen, ob je ein
`pointerdown` stattgefunden hatte. Auf dem Desktop wurde damit schlichtes
Mausbewegen als Wischgeste gelesen.

Behebung: `active`-Flag, das nur zwischen `pointerdown` und `pointerup` gilt,
plus zwei mausspezifische Prüfungen — `e.button !== 0` (nur die primäre Taste
startet) und `!(e.buttons & 1)` (Taste außerhalb losgelassen → abbrechen).

### Karten erschienen an unvorhersehbaren Stellen

Die „ersten vier bekommen Kartenformat"-Regel arbeitete auf der **global**
sortierten Liste; die vier wurden dann aber in ihren jeweiligen Tagesabschnitt
einsortiert. Im KI-Modus streuten sie über die Tage, und mitten im Feed
tauchten scheinbar willkürlich große Karten auf.

Behebung: Kartenformat nur für die ersten vier der **obersten** Sektion.

### „Heute" stand unter älteren Videos

Die Reihenfolge der Tagesabschnitte ergab sich daraus, welches Video im Ranking
zuerst auftauchte — im KI-Modus wird aber nach Punktzahl sortiert. Ein paar Tage
altes, hoch bewertetes Video schob seine Sektion vor „Heute".

Behebung: feste Abschnittsreihenfolge, Ranking wirkt nur noch innerhalb eines
Abschnitts.

### Gelöschte Kanäle ließen ihre Videos zurück

`stage0Reject` prüfte nur `channel.active === false` (stummgeschaltet), nicht
„Kanal existiert gar nicht mehr" (gelöscht). Die Videos fielen durch jede
Prüfung hindurch und blieben für immer im Feed.

Behebung: fehlender Kanaleintrag ist jetzt ein eigener Ablehnungsgrund; das
Löschen eines Kanals räumt seine Videos zusätzlich gleich mit weg.

### „Aktualisieren" verlangte einen Key, der im Formular stand

Der Knopf las die Einstellungen aus der Datenbank, während die eingetippten
Werte noch im ungespeicherten Formular standen — und der Speichern-Knopf lag
unterhalb von vier Abschnitten. Behebung: automatisches Speichern beim
Verlassen eines Feldes plus `flushPendingSettings()` zu Beginn jedes Laufs.

### Kleinigkeiten mit großer Wirkung

- **Passwortmanager füllten die API-Key-Felder** — behoben mit
  `autocapitalize="off"`, `autocorrect="off"`, `data-1p-ignore`, `data-lpignore`,
  `data-bwignore`.
- **Der „Aktualisieren"-Knopf schob die Nav-Tabs vom Bildschirm** auf
  iPhone-Breite — die Einstellungen waren dadurch nicht mehr erreichbar.
  Behoben mit `@media (max-width: 640px)`.
- **Safari und die Home-Bildschirm-App teilen ihren Speicher nicht.** Was in
  Safari eingetragen wird, kennt die installierte App nicht. Steht deshalb als
  Warnung im README.

---

## 10. Was bewusst nicht gebaut wurde

| Nicht gebaut | Grund |
|---|---|
| OAuth / YouTube-Login | Randbedingung 1. Ein API-Key hängt am Cloud-Projekt, nicht am Konto. |
| yt-dlp, Stream-Extraktion, Adblock | Verstößt gegen die YouTube-ToS und wäre genau die Sperre, die vermieden werden soll. |
| Eigene Bedienelemente über dem Player | Required Minimum Functionality — der offizielle `youtube-nocookie`-Player bleibt unangetastet. |
| Server, Backend, Cronjob | Randbedingungen 2 und 3. Kein nächtlicher Vorlauf ist der bewusst akzeptierte Preis. |
| Framework, Bundler, Build-Pipeline | Direkte Bearbeitbarkeit auf github.com ist unterwegs der Notausgang. |
| Lese-Cache für Einstellungen | Ein veralteter Cache wäre unterwegs nicht zu diagnostizieren (zwei Tabs, eingespielte Sicherung). Siehe [settings.js:61](js/settings.js:61). |
| Umbenennung der IndexedDB | Siehe Abschnitt 4 — Datenverlust ohne Gegenwert. |

---

## 11. Chronik

| Commit | Was |
|---|---|
| `49e6497` | Erste Fassung: privater Feed ohne Shorts und ohne alte Videos |
| `af6fa93` | „Aktualisieren" verlangte einen Key, der schon im Formular stand |
| `d03b5d5` | Service Worker fror veraltetes JavaScript dauerhaft ein |
| `4d100e8` | Abos.csv direkt aus der Dateien-App laden |
| `82055c3` | Umbenennung zu MyTube plus vier Fehlerbehebungen |
| `95778d1` | Service Worker: 404/500 nicht mehr als Erfolg behandeln |
| `aced49b` | Entdecken: Vorschläge außerhalb der Abos, mit Aufruf-Hürde |
| `c5bac96` | Gesehenes wegräumen — und „Ausblenden" war ein falsches Signal |
| `dcf75be` | Feed-Redesign „Die Tagesausgabe" nach Red-Team-Workflow |
| `539d248` | Feed-Feinschliff nach echter Nutzung, plus Merkliste |
| `4874421` | Geräteabgleich: Mac, iPad und iPhone teilen sich einen Stand |
| `0c9582f` | Feed: Tages-Abschnitte in fester Reihenfolge statt nach Ranking |

---

## 12. Für die nächste Änderung

- **Syntax prüfen** mit `node --input-type=module --eval "$(cat datei.js)"`,
  nicht mit `node --check`.
- **`sw.js` Version hochzählen** bei jeder Änderung an App-Dateien, sonst
  serviert das iPad die alte Fassung.
- **Vor dem Push `git status`** — unter `Google/` liegen der echte API-Key und
  die echte Abo-Liste, ausgeschlossen per `.gitignore`.
- **Nach dem Push warten und prüfen:**
  `curl -s "https://maam783.github.io/mytube/sw.js?b=$RANDOM" | grep VERSION`
  — GitHub Pages braucht ein bis zwei Minuten.
- **Behauptungen messen, nicht annehmen.** Die Feedback-Zählungen, die
  UULF/UUSH-Überlappung, die Verschlüsselung im hochgeladenen Payload und die
  `maxResults`-Quota-Kosten wurden alle nachgeprüft — jedes Mal mit einem
  Ergebnis, das eine Annahme korrigiert hat.
