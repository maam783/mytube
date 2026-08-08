# PrivateTube iPad — Konzept & Spec

**Ein privater, KI-kuratierter YouTube-Feed für das iPad**

Stand: 6. August 2026 · Ersetzt das frühere iOS/tvOS-Konzept · Für: Claude Code und Marco

---

## 0. Was sich geändert hat — und warum das gut ist

Das vorherige Konzept scheiterte an einem einzigen Punkt: **tvOS hat kein WebKit.** Daraus folgte alles andere — eigene Stream-Extraktion, yt-dlp, PO-Tokens, Wegwerf-Account, Cookie-Pflege, Residential-IP, ein Bruch alle 4–8 Wochen.

Auf dem iPad gibt es WKWebView. Damit läuft der **offizielle YouTube-Player**, und der komplette fragile Teil entfällt:

| Vorher (tvOS) | Jetzt (iPad) |
|---|---|
| yt-dlp + Fallback-Kette über 4 Clients | — |
| bgutil-PO-Token-Provider, Deno-Runtime | — |
| Wegwerf-Account + Cookie-Rotation | — |
| Residential-IP zwingend | — |
| Byte-Relay, HMAC-URLs, IPv6-Fallen | — |
| Canary, Auto-Update, Rollback | — |
| Bruch alle 4–8 Wochen | ~1 relevante Änderung pro Jahr |
| 4 Container | 1 Python-Prozess + 1 SQLite-Datei |

Was bleibt, ist **das eigentliche Produkt**: ein Feed, der dir zeigt, was du sehen willst. Der Player war nie das Problem.

### Der eine Haken, den du kennen musst

**Im eingebetteten Player wirkt dein Premium-Abo mit hoher Wahrscheinlichkeit nicht.** Der Embed lädt YouTube als Third-Party-Inhalt; WebKit blockt Third-Party-Cookies vollständig (Safari seit 13.1, ITP in WKWebView per Default seit iOS 14). Ohne Cookies erkennt YouTube dein Abo nicht → Werbung trotz Bezahlung. Google formuliert die Bedingung selbst: *„make sure you're not blocking YouTube cookies"*.

Deshalb hat jedes Video zusätzlich **„In YouTube öffnen"**. Dort greift dein Premium vollständig — werbefrei, Hintergrund-Audio, PiP, AirPlay auf den Apple TV. Das ist kein Notnagel, sondern für lange Videos vermutlich der bessere Weg.

### Drei harte Grenzen des Embeds

1. **Kein Hintergrund-Audio.** Vertraglich verboten (Developer Policies) *und* technisch gesperrt (WKWebView fehlt das Entitlement). Die App Musi hat genau darüber im März 2026 vor Gericht verloren. Kein Graubereich.
2. **Kein Picture-in-Picture.** Das `<video>`-Element liegt im cross-origin iframe; Apple verlangt zusätzlich eine Nutzergeste. Nicht lösbar.
3. **Keine eigenen Bedienelemente über dem Player.** Die Required Minimum Functionality verbietet Overlays wörtlich: *„You must not display overlays, frames, or other visual elements in front of any part of a YouTube embedded player, including player controls."* Eigene Elemente **neben oder unter** dem Player sind erlaubt — dort gehören auch die Daumen-Buttons hin.

Alle drei verschwinden, sobald du „In YouTube öffnen" benutzt.

---

## 1. Entscheidungen

| Frage | Entscheidung |
|---|---|
| Wiedergabe | **Hybrid** — eingebetteter Player, jedes Video zusätzlich mit „In YouTube öffnen" |
| Erster Schritt | **Webseite vor App** — Phase 1 ist eine Seite, die du auf dem iPad in Safari öffnest |
| Backend | **Kleiner Cloud-Server** (Hetzner o. ä., Größenordnung 4–5 €/Monat) |
| Quellen | Abos + Themen-Discovery (max. 10 Suchen/Tag) |
| Filterlogik | Manifest in Prosa + Daumen-Feedback, das zurückfließt |

**Warum Webseite vor App:** Die offene Frage ist nicht „läuft der Player", sondern **„ist der KI-Filter gut genug"**. Das beantwortest du mit einer Webseite in Tagen statt in Wochen — ohne Xcode, ohne Signieren, ohne Provisioning-Profile. Und du kalibrierst das Manifest an echten Ergebnissen, bevor eine Zeile SwiftUI entsteht. Die native App wird danach besser, weil du dann weißt, was sie können muss.

**Warum die Cloud jetzt in Ordnung ist:** IP-Reputation war nur für die Stream-Extraktion relevant. Die YouTube **Data API** ist der offizielle, authentifizierte Weg — Datacenter-IPs sind dort völlig unproblematisch. Der Grund, der vorher zwingend für den Mac mini sprach, ist ersatzlos weg. Ein Cloud-Server ist dafür immer erreichbar, auch wenn zuhause der Strom weg ist.

---

## 2. Architektur

```
┌─────────────────────────────────────────────────┐
│  Cloud-Server (1 vCPU, 2 GB reichen)            │
│                                                 │
│  FastAPI                                        │
│   ├─ APScheduler: täglicher Ingest + Scoring    │
│   ├─ HTML-Seite (Jinja2) für Safari auf dem iPad│
│   └─ JSON-API (später für die native App)       │
│                                                 │
│  SQLite (WAL)                                   │
│  Caddy → HTTPS + Basic Auth                     │
└─────────────────────────────────────────────────┘
        ↓ https://tube.deinedomain.de
   iPad · Safari (Phase 1) → native App (Phase 2)
```

Ein Prozess, eine Datei, ein Reverse Proxy. Docker Compose mit zwei Services (`app`, `caddy`) oder schlicht systemd — beides vertretbar.

**Absicherung:** Die Seite ist öffentlich erreichbar, also HTTP Basic Auth über Caddy (Let's Encrypt automatisch). Auf dem Server liegen dein OAuth-Refresh-Token und dein Anthropic-Key — das ist der Grund, warum Basic Auth kein „später" ist. Alternativ Tailscale statt öffentlicher Domain; dann brauchst du kein Zertifikat, aber der Kalendereintrag „Tailscale auf dem iPad aktiv?" wird zum Alltagsärgernis. Ich würde Domain + Basic Auth nehmen.

---

## 3. Ingest

### 3.1 Quellen

**Abo-Sync, wöchentlich:** `subscriptions.list(mine=true, maxResults=50)` → 3–4 Calls. In `channels` mit `active`-Flag, damit du Kanäle lokal stummschalten kannst, ohne sie auf YouTube zu deabonnieren.

**Neue Videos, täglich:** Kanal-ID `UC…` per String-Ersetzung zu `UULF…` (Uploads ohne Shorts) — kein `channels.list`-Call nötig. Dann `playlistItems.list(playlistId=UULF…, maxResults=15)`. Neueste zuerst, also abbrechen bei bekannter Video-ID.

> **Abweichung vom alten Konzept:** Dort war RSS der Primärweg, um Quota zu sparen. Auf einem Cloud-Server ist das die schlechtere Wahl — RSS ist ein ungeschützter Scraping-Endpunkt, bei dem Datacenter-IPs eher auffallen, und die Quota reicht sowieso dreifach. **Nimm die API als Primärweg.** RSS optional als Ergänzung, nicht als Fundament.
>
> `UULF` ist undokumentiert und kann verschwinden. Fallback auf `UU…` + Dauer-Heuristik einbauen und sichtbar loggen.

**Themen-Discovery, täglich, max. 10 Suchen:** `search.list` liegt seit dem 1. Juni 2026 in einem eigenen Bucket mit hartem Limit von **100 Calls/Tag**. Als Ingest-Weg unbrauchbar, als Discovery gut genug. Gefundene Kanäle landen mit Status `pending` in einem „Neue Kanäle"-Bereich — sie kommen **nicht** automatisch in den Feed, sondern erst nach deiner Freigabe. Abgelehnte auf die Blockliste.

### 3.2 Metadaten — und ein wichtiges Feld

`videos.list` in 50er-Batches. **`part=status` immer mitnehmen** — `videos.list` kostet **1 Unit unabhängig von der Anzahl der Parts**, das ist also gratis.

Relevante Felder:

| Feld | Wofür |
|---|---|
| `status.embeddable` | **Zentral.** Sagt vorab, ob das Video eingebettet werden darf |
| `contentDetails.regionRestriction` | zweiter Grund für fehlschlagende Embeds |
| `contentDetails.contentRating.ytRating` | `ytAgeRestricted` → Embed wird blockiert |
| `status.madeForKids` | Policies verlangen, dass du das abfragst und Tracking abschaltest |
| `contentDetails.duration` | Dauer-Filter, Shorts-Heuristik |
| `snippet.defaultAudioLanguage` | Sprachfilter aus dem Manifest |
| `liveStreamingDetails` | Premieren/Livestreams kommen mit Dauer `P0D` und würden sonst wegfliegen |

Videos mit `embeddable = false` werden **nicht aussortiert** — sie bekommen im Feed nur direkt den „In YouTube öffnen"-Knopf statt des Players. Das kostet nichts und du verlierst keinen Inhalt.

### 3.3 Quota

| Posten | Units/Tag |
|---|---|
| Abo-Sync (wöchentlich, anteilig) | < 1 |
| 150 Kanäle × `playlistItems.list` | 150 |
| Metadaten für ~100 neue Videos | 2 |
| **Summe** | **~155 von 10.000** |
| Discovery | 10 von 100 Search-Calls |

Rund 1,5 % der Gratis-Quota. Kein Antrag, kein Compliance-Audit nötig — das braucht man nur für Quota *über* dem Standard.

### 3.4 OAuth — die eine Falle

Ein Google-Cloud-Projekt im **Testing-Modus lässt Autorisierungen nach 7 Tagen verfallen**, inklusive Refresh Token. Für einen täglichen Job tödlich.

**Lösung:** App auf „In production" publishen, aber **nicht** verifizieren lassen. Der 7-Tage-Ablauf gilt nur für Testing. Einmalig den „nicht verifiziert"-Warnscreen über „Erweitert" durchklicken. Trotzdem `invalid_grant` behandeln und dir eine Mail schicken, statt still zu scheitern.

---

## 4. Der KI-Filter

Das ist das Produkt. Alles andere ist Infrastruktur.

### 4.1 Manifest

Eine Markdown-Datei, versioniert in der DB, im Browser editierbar:

```markdown
## Was ich sehen will
- Tiefe technische Erklärungen, auch wenn sie 40 Minuten dauern
- Handwerk und Fertigung, wo man jemandem echt bei der Arbeit zusieht

## Was ich nicht sehen will
- Reaction-Videos, Drama, Kommentare zu anderen Kanälen
- "SHOCKING", "You won't believe", übertriebene Thumbnails
- News-Kommentierung ohne eigenen Rechercheanteil

## Kontext über mich
- Deutsch und Englisch; anderes nur mit guten Untertiteln
- Abends eher lang und ruhig, mittags eher kurz

## Grenzfälle
- Sponsor-Segmente stören nicht, wenn der Rest gut ist
- Bei Musik gilt das alles nicht
```

### 4.2 Zwei Stufen

**Stufe 0 — kostenlos.** Blockierte Kanäle, Shorts, Dauer außerhalb `[min, max]` (Livestreams ausgenommen), gesehene, verworfene, Duplikate. Reduziert um 30–50 %.

**Stufe 1 — Claude Haiku, Batches à 25.** Input: Titel, Kanal, Beschreibung (500 Zeichen), Dauer, Tags, Datum, Views, Sprache — plus Manifest und Feedback-Beispiele.

Output über **Tool-Use erzwungen** (nicht per Prompt-Bitte — Tool-Use garantiert schemakonformes JSON):

```json
{ "video_id": "…", "score": 0, "reason": "ein Satz, warum", "tags": ["…"] }
```

Fehlerbehandlung explizit: ungültiges Ergebnis → Batch einmal wiederholen → dann einzeln nachfahren → Rest mit `score = NULL` in eine Retry-Queue. Nie still verwerfen.

Die **`reason` ist Produkt, nicht Debug-Ausgabe** — sie steht unter jedem Video im Feed. Das ist der ganze Unterschied zu einem Blackbox-Algorithmus: du siehst immer, warum dir etwas vorgeschlagen wird, und kannst gezielt widersprechen.

**Kosten:** ~100 Videos/Tag, ~60k Input-Tokens auf Haiku → deutlich unter 1 €/Tag. `spend_log` mit Tagesbudget und Hard-Stop trotzdem einbauen.

**Backfill beim ersten Lauf:** 30 Tage je Kanal, Größenordnung 2.000–4.000 Videos. Einmalig ein paar Euro — über mehrere Läufe verteilen, damit es nicht gegen das Tagesbudget läuft.

*(Eine Stufe 2 mit Transkript und Clickbait-Erkennung ist möglich, aber Phase 4. Transkripte sind 2026 der fragilste denkbare Baustein — `timedtext` liefert bei manchen Videos leere Antworten, `youtube-transcript-api` hat seit Januar kein Release. Genau die Art Abhängigkeit, die du gerade losgeworden bist. Erst bauen, wenn Stufe 1 nachweislich an ihre Grenze stößt.)*

### 4.3 Feedback

| Signal | Gewicht | Quelle |
|---|---|---|
| Daumen hoch/runter | stark | Buttons im Feed und unter dem Player |
| „Mehr/weniger von diesem Kanal" | stark | Kanalzeile |
| Zu Ende geschaut (>90 %) | mittel | IFrame-API `onStateChange` |
| Nach <30 s abgebrochen | mittel, negativ | IFrame-API |
| Weggewischt | schwach, negativ | Feed |

Die IFrame-JS-API (`onStateChange`, `getCurrentTime`) funktioniert in der Webseite normal — sie läuft über `postMessage` und ist von der Cookie-Blockade nicht betroffen. Beim Weg über „In YouTube öffnen" fehlt dieses Signal; dann zählt nur das explizite Feedback. Das ist verkraftbar.

**Nur explizites Feedback darf einen Kanal dauerhaft abwerten.** Ein Abbruch nach 20 Sekunden kann „schlecht" heißen oder „jemand hat geklingelt".

**Rückfluss:** die 15 zuletzt positiv und 15 zuletzt negativ bewerteten Videos als Few-Shot-Beispiele ins Prompt. Kein Fine-Tuning.

**Kaltstart:** In den ersten zwei Wochen zeigt der Feed bewusst mehr Grenzfälle (Score 40–70), damit du schnell Signal lieferst. Mit einem sichtbaren „Kalibrierung"-Hinweis, damit du weißt, warum.

**Gegen Filterblasen-Kollaps:** Jede 10. Feed-Position ist ein Exploration-Slot — mittlere Scores oder länger nicht gesehene Kanäle, markiert als „Ausprobiert für dich". Deren Feedback zählt doppelt, weil es am meisten Information trägt. Ohne das konvergierst du auf dieselbe Enge, die dich an YouTube stört, nur mit anderem Vorzeichen.

### 4.4 Manifest-Vorschläge — nie automatisch

Wöchentlich: Claude bekommt Manifest plus alle Fälle, wo Score und dein Urteil auseinanderlagen, und formuliert **Änderungsvorschläge als Diff mit Begründung**. Die landen in einem Bereich der Seite; du nimmst an oder verwirfst.

Bewusst so: Ein selbstoptimierender Filter, den du nicht mehr liest, ist wieder ein Algorithmus, dem du ausgeliefert bist. Der Punkt der ganzen Übung ist, dass du die Kontrolle behältst.

---

## 5. Die Wiedergabe

### 5.1 Der eingebettete Player

```html
<iframe
  src="https://www.youtube-nocookie.com/embed/VIDEO_ID?enablejsapi=1&playsinline=1&rel=0&origin=https://tube.deinedomain.de"
  allow="accelerometer; encrypted-media; picture-in-picture; web-share"
  allowfullscreen>
</iframe>
```

**Pflichten aus der Required Minimum Functionality** — nicht optional, auch für private Apps gibt es keine schriftliche Ausnahme:

- Player mindestens **200×270 px**, empfohlen ≥ 480×270 bei 16:9
- **Kein Overlay über dem Player**, auch nicht über den Controls. Daumen-Buttons gehören darunter.
- Kein Autoplay, solange weniger als die Hälfte des Players sichtbar ist
- **API-Client-Identifikation per Referer** — Pflicht seit 7. Juli 2025. In der Webseite ist das automatisch deine Domain; in der nativen App später die Bundle-ID in Reverse-DNS-Form.
- Werbung nicht blockieren, modifizieren oder ersetzen
- Links müssen in der YouTube-App öffnen, falls installiert

**Fehlerbehandlung zur Laufzeit** über `onError`: Code `101`/`150` = Einbettung vom Uploader deaktiviert, `100` = nicht gefunden, `5` = HTML5-Fehler. In allen Fällen: Player ausblenden, „In YouTube öffnen" anbieten, und das Video in der DB als `embed_failed` markieren, damit es beim nächsten Mal gleich richtig gerendert wird.

**Gelegentliche Bot-Checks** („Sign in to confirm you're not a bot") treffen seit Ende 2025 auch IFrame-Player. Bekannter Fix: einmal im selben Kontext bei YouTube einloggen. In der Webseite auf dem iPad heißt das schlicht: in Safari eingeloggt bleiben.

### 5.2 „In YouTube öffnen"

```
youtube://watch?v=VIDEO_ID     → öffnet die App, falls installiert
https://www.youtube.com/watch?v=VIDEO_ID   → Fallback
```

Dort funktioniert alles, was das Embed nicht kann: Premium greift (werbefrei), Hintergrund-Audio, PiP, AirPlay auf den Apple TV. Für lange Videos vermutlich der Weg, den du gewohnheitsmäßig nimmst.

**Praktischer Nebeneffekt, den du im Blick behalten solltest:** Damit hast du deinen Apple TV faktisch mit abgedeckt — Video im Feed antippen, per AirPlay aus der YouTube-App auf den Fernseher. Nicht so elegant wie eine eigene tvOS-App, aber zuverlässig und heute schon da.

**Position merken:** Nach der Rückkehr aus der YouTube-App weiß deine Seite nicht, wie weit du gekommen bist. Deshalb: beim Zurückkommen einmal fragen („Gesehen? 👍 👎 / Später"). Ein Tap, mehr nicht — sonst verhungert der Feedback-Loop genau bei den Videos, die du am ernsthaftesten geschaut hast.

---

## 6. Datenmodell (SQLite)

```sql
channels(
  id TEXT PRIMARY KEY, title TEXT, thumbnail_url TEXT,
  uploads_playlist_id TEXT, longform_playlist_id TEXT,
  source TEXT,                       -- subscription|discovery|manual
  active INTEGER DEFAULT 1, weight REAL DEFAULT 1.0,
  added_at, last_polled_at, last_poll_status
);

videos(
  id TEXT PRIMARY KEY, channel_id TEXT REFERENCES channels(id),
  title TEXT, description TEXT, published_at TEXT,
  duration_seconds INTEGER, is_short INTEGER,
  live_status TEXT, scheduled_start_at TEXT,
  default_audio_language TEXT, made_for_kids INTEGER,
  embeddable INTEGER,                -- aus status.embeddable
  embed_failed INTEGER DEFAULT 0,    -- zur Laufzeit gelernt
  region_blocked JSON, age_restricted INTEGER,
  view_count INTEGER, thumbnail_url TEXT, tags JSON, chapters JSON,
  watched INTEGER DEFAULT 0, dismissed INTEGER DEFAULT 0,
  ingested_at
);
CREATE INDEX idx_videos_state ON videos(watched, dismissed, published_at DESC);
CREATE INDEX idx_videos_channel ON videos(channel_id);

scores(
  id INTEGER PRIMARY KEY, video_id TEXT REFERENCES videos(id),
  stage INTEGER, score INTEGER, reason TEXT, tags JSON,
  model TEXT, manifest_version INTEGER,
  is_current INTEGER DEFAULT 1, created_at
);
CREATE INDEX idx_scores_current ON scores(video_id, is_current);

feedback(
  id INTEGER PRIMARY KEY, client_event_id TEXT UNIQUE,   -- Idempotenz
  video_id TEXT, type TEXT,          -- thumb|completion|skip|dismiss|channel_pref
  value REAL, position_seconds INTEGER, created_at
);

playback_state(video_id TEXT PRIMARY KEY, position_seconds INTEGER, updated_at);
manifest_versions(version INTEGER PRIMARY KEY, content TEXT, created_at, note TEXT);
manifest_suggestions(id INTEGER PRIMARY KEY, manifest_version INTEGER,
                     diff TEXT, rationale TEXT, status TEXT, created_at, decided_at);
discovery_queries(id INTEGER PRIMARY KEY, query TEXT, active INTEGER, last_run_at);
discovered_channels(channel_id TEXT PRIMARY KEY, found_via TEXT, status TEXT, found_at);
blocklist(channel_id TEXT PRIMARY KEY, reason TEXT, created_at);
spend_log(day TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER,
          cost_eur REAL, PRIMARY KEY(day, model));
```

---

## 7. Die Seite (Phase 1)

Server-gerendertes HTML (Jinja2), auf iPad-Breite optimiert, „Zum Home-Bildschirm" als Icon. Kein Framework nötig — etwas Vanilla-JS für die IFrame-API und die Feedback-Posts reicht.

```
/                     Feed
/video/<id>           Detail mit Player
/channels             Kanäle verwalten, stummschalten
/discovery            neue Kanäle prüfen
/manifest             Editor
/suggestions          wöchentliche Änderungsvorschläge
/status               letzter Ingest, Quota, Kosten, Fehler
```

**Feed-Zeile:** großes Thumbnail, Titel, Kanal, Dauer, darunter der `reason`-Satz kleiner. Rechts zwei Buttons: 👍 👎. Ein Tap, nicht zwei — sonst wird es nicht benutzt.

**Ranking**, vor der Paginierung einmal vollständig berechnet:

1. Kandidaten: alle ungesehenen Videos der letzten 30 Tage mit Score
2. Basis: `score_norm × exp(-alter_tage / 7) × kanal_gewicht`
3. Absteigend durchgehen, pro bereits platziertem Video desselben Kanals `× 0.6` (Maximal-Marginal-Relevance). Ohne diesen Schritt dominiert ein produktiver Lieblingskanal den ganzen Feed.
4. Jede 10. Position: Exploration-Slot aus dem Mittelfeld
5. Ergebnis als Liste cachen, neu berechnen bei Ingest, Feedback oder nach 30 Minuten

**Idempotenz:** `/feedback` verlangt eine client-generierte UUID. Sonst dupliziert ein Retry nach Netzabbruch die Signale und verzerrt den Loop.

---

## 8. Phasen

### Phase 0 — zwei Stunden, bevor irgendetwas gebaut wird

1. **Google-Cloud-Projekt** anlegen, YouTube Data API aktivieren, OAuth-Client erstellen, **auf „In production" setzen** (nicht Testing!), einmal autorisieren, Refresh Token sichern.
2. **Embed-Test auf dem iPad:** Eine einzelne statische HTML-Datei mit einem IFrame-Embed auf dem Server ablegen und in Safari auf dem iPad öffnen. Prüfen: Läuft das Video? Kommt Werbung, obwohl du mit Premium in Safari eingeloggt bist? Funktioniert Fullscreen?

   **Das ist die einzige echte Unbekannte.** Wenn Premium wider Erwarten greift, ist das Embed die Hauptwiedergabe. Wenn nicht, wird „In YouTube öffnen" der Standardweg und das Embed die Vorschau. Beides ist ein gutes Ergebnis — aber du willst es wissen, bevor du die UI darum herum baust.

**Abnahme:** Refresh Token funktioniert nach 8 Tagen noch. Embed-Verhalten dokumentiert.

### Phase 1 — Feed, der funktioniert (Woche 1)
Ingest über die Data API, SQLite, Stufe-0- und Stufe-1-Scoring, Backfill über 30 Tage, HTML-Feed mit Player und Feedback-Buttons, Manifest-Editor, `/status`.

**Abnahme:** Du öffnest die Seite auf dem iPad, siehst 50 Videos in plausibler Reihenfolge mit sinnvollen `reason`-Sätzen, kannst eins abspielen und bewerten. Der tägliche Lauf bleibt unter 200 Quota-Units.

### Phase 2 — kalibrieren (Woche 2–3, hauptsächlich Nutzung)
Manifest an echten Ergebnissen schärfen. Feedback-Rückfluss, Exploration-Slots, Kanal-Verwaltung, Discovery-Prüfung, Manifest-Vorschläge.

**Abnahme:** Nach ~100 Bewertungen ist eine messbare Verschiebung der Score-Verteilung nachweisbar, und du kannst benennen, was der Filter jetzt besser trifft als vorher.

### Phase 3 — native iPad-App (Woche 4–5, optional)
SwiftUI, `YouTubePlayerKit` (2.0.5, aktiv gepflegt, Swift 6). Dieselbe JSON-API. Gewinn: besseres Scrolling, Home-Screen-Integration, Offline-Cache der Metadaten, Push bei interessanten Neuzugängen.

Wichtig für die App: `allowsInlineMediaPlayback = true`, `mediaTypesRequiringUserActionForPlayback = []`, `preferences.isElementFullscreenEnabled = true` (steht per Default auf `false` und ist die häufigste Ursache für „Fullscreen geht nicht"), und die Bundle-ID als Origin für die Referer-Pflicht.

**Baue diese Phase erst, wenn Phase 2 dich überzeugt hat.** Wenn der Filter nicht taugt, hilft keine App.

### Phase 4 — später, nur bei Bedarf
Stufe-2-Tiefenprüfung mit Transkripten (Clickbait-Erkennung), Embedding-basierte Beispielauswahl, iPhone-Target, ein tvOS-Frontend, das die Wiedergabe an die YouTube-App abgibt.

---

## 9. Für Claude Code — das Wesentliche

1. **Phase 0 zuerst.** OAuth auf „In production", sonst stirbt der Job nach 7 Tagen. Und den Embed-Test auf dem echten iPad machen, bevor die UI entsteht.
2. **Keine Stream-Extraktion. Kein yt-dlp. Keine Cookies.** Wenn das im Code auftaucht, ist etwas falsch verstanden worden.
3. **`part=status` immer mitholen** — kostet nichts extra und `status.embeddable` entscheidet über die Darstellung.
4. **Jedes Video hat immer „In YouTube öffnen"**, auch wenn das Embed funktioniert.
5. **Kein Overlay über dem Player.** Bedienelemente darunter. Das ist eine ToS-Vorgabe, kein Designgeschmack.
6. **`search.list` = 100 Calls/Tag, eigener Bucket.** Nur Discovery, nie Ingest.
7. **Der `reason`-Satz steht in der UI.** Er ist der Grund, warum diese App existiert.
8. **Das Manifest ändert sich nie automatisch** — nur über bestätigte Vorschläge.
9. **Alles degradiert, nichts stürzt ab.** UULF weg → UU + Heuristik. Embed kaputt → YouTube-Link. Scoring fehlgeschlagen → Retry-Queue. Jede Degradation sichtbar loggen, nie still schlucken.
10. **Erst Webseite, dann App.** Nicht mit SwiftUI anfangen.

---

## Quellen

**Player & Einbettung**
- [IFrame Player API Reference](https://developers.google.com/youtube/iframe_api_reference) · [Player-Parameter](https://developers.google.com/youtube/player_parameters)
- [Required Minimum Functionality](https://developers.google.com/youtube/terms/required-minimum-functionality) · [Developer Policies](https://developers.google.com/youtube/terms/developer-policies) · [ToS Revision History (Referer-Pflicht 07.07.2025)](https://developers.google.com/youtube/terms/revision-history)
- [YouTubePlayerKit](https://github.com/SvenTiigi/YouTubePlayerKit) · [youtube-ios-player-helper (archiviert 12/2024)](https://github.com/youtube/youtube-ios-player-helper)

**Premium & Cookies im Embed**
- [YouTube Hilfe: „I see ads on YouTube videos"](https://support.google.com/youtube/answer/7437519) · [Ads on embedded videos](https://support.google.com/youtube/answer/132596)
- [Microsoft Q&A: Premium zeigt trotzdem Werbung im Embed](https://learn.microsoft.com/en-us/answers/questions/5433522/youtube-premium-still-shows-ads-in-embedded-powerp) · [Third-Party-Cookies in Safari-Iframes](https://blog.certa.dev/third-party-cookie-restrictions-for-iframes-in-safari) · [ITP in WKWebView seit iOS 14](https://www.thinktecture.com/en/ios/wkwebview-itp-ios-14/)

**Grenzen auf iPadOS**
- [Apple Forum: PiP aus Inline-Playback gesperrt](https://developer.apple.com/forums/thread/819235) · [Apple Forum: kein Background-Audio in WKWebView](https://developer.apple.com/forums/thread/781787) · [Musi verliert Klage gegen Apple, 03/2026](https://www.macrumors.com/2026/03/18/apple-wins-victory-musi-app-store-lawsuit/)
- [Bot-Check im IFrame-Player, 12/2025](https://www.inmatrix.com/blog/youtube_sign_in_to_confirm_you_are_not_a_bot_iframe_player_fix.shtml)

**Data API**
- [Quota-Kosten](https://developers.google.com/youtube/v3/determine_quota_cost) · [Getting Started](https://developers.google.com/youtube/v3/getting-started) · [videos-Ressource](https://developers.google.com/youtube/v3/docs/videos) · [Quota & Compliance Audits](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits)
- [OAuth Publishing-Status & 7-Tage-Ablauf](https://developers.google.com/identity/protocols/oauth2) · [UULF/UUSH-Präfixe](https://zegnat.bearblog.dev/the-rss-world-of-youtube/)
