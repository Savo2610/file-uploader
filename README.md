# upload.veerka.mp

Ein Briefkasten, in den mir andere Dateien legen können. Läuft als Cloudflare
Worker: die Dateien landen in einem privaten R2-Bucket, Protokoll und
Kontingent stehen in D1.

Zwei Adressen, ein Worker:

| Adresse              | Wer          | Wofür                                 |
| -------------------- | ------------ | ------------------------------------- |
| `upload.veerka.mp`   | jeder        | Dateien und Texte einwerfen           |
| `download.veerka.mp` | nur mit 2FA  | ansehen, herunterladen, löschen       |

Getrennt wird nach Hostnamen, und zwar nicht nur in der Anzeige: unter
`upload.veerka.mp` existieren die Routen zum Abholen schlicht nicht, auch
nicht mit gültigem Sitzungstoken.

```bash
# Beide Seiten einzeln starten – siehe Kommentar in tools/test-api.mjs
npm run dev            # upload.veerka.mp   auf :8788
npm run dev:download   # download.veerka.mp auf :8789

npm test               # 43 End-to-End-Tests gegen beide
npm run cleanup        # Testdateien wieder wegräumen
npm run deploy         # von Hand veröffentlichen
```

Gegen die echte Seite laufen die Tests auch – dann legen sie dort aber
Dateien an:

```bash
UPLOAD_BASE=https://upload.veerka.mp DOWNLOAD_BASE=https://download.veerka.mp npm test
node tools/cleanup-tests.mjs --remote
```

## Struktur

| Pfad                 | Was drin ist                                          |
| -------------------- | ----------------------------------------------------- |
| `public/index.html`  | die Upload-Seite                                       |
| `public/download.html` | die Abhol-Seite                                      |
| `public/style.css`   | gemeinsames Aussehen beider Seiten                     |
| `public/_headers`    | Cache- und Sicherheits-Header                          |
| `src/index.js`       | die API, und welche Route unter welchem Host existiert |
| `src/crypto.js`      | TOTP nach RFC 6238 und signierte Sitzungstoken         |
| `schema.sql`         | Tabellen für D1                                        |
| `tools/test-api.mjs` | 43 Tests, vor allem gegen Umgehungsversuche            |
| `tools/cleanup-tests.mjs` | räumt nur die Testdateien weg, nichts sonst      |
| `TEXT_INPUT_FEATURE.md` | Notiz zu einer noch nicht gebauten Idee            |

## Wie ein Upload läuft

1. `POST /api/upload/init` – der Browser meldet Name und Größe an. **Hier**
   entscheidet der Server über Limit und Tageskontingent und legt einen
   R2-Multipart-Upload an. Zurück kommt ein zufälliges Upload-Token.
2. `PUT /api/upload/part?upload=…&part=n` – die Datei geht in 10-MB-Stücken
   hoch, drei gleichzeitig.
3. `POST /api/upload/complete` – R2 setzt die Teile zusammen.

Weil alles über die eigene Domain läuft, liefert `XMLHttpRequest.upload`
echten Fortschritt in Prozent. (Beim alten Weg über Google Apps Script ging
das nicht: ein Listener darauf erzwingt einen CORS-Preflight, den Apps Script
nicht beantwortet.)

## Text und Links

Neben Dateien gibt es ein Textfeld. Der Inhalt landet **nicht** als Datei in
R2, sondern direkt in D1 – dadurch steht er in der Liste sofort lesbar da und
lässt sich mit einem Tipp kopieren, ohne vorher etwas herunterzuladen. Genau
das war der Sinn der Sache: unterwegs schnell an eine Adresse oder einen Link
kommen.

Beim Anzeigen werden `http(s)`-Adressen anklickbar gemacht, alles andere
bleibt Text. Der Aufbau läuft über DOM-Knoten, nie über `innerHTML` – sonst
wäre ein eingefügtes `<script>` ein Einfallstor, und `javascript:`-Adressen
würden anklickbar.

## Limits

|                        | ohne Code | mit 2FA-Code |
| ---------------------- | --------- | ------------ |
| pro Datei              | 50 MB     | 10 GB        |
| Dateien pro 24 h       | 50        | unbegrenzt   |
| davon pro Absender-IP  | 30        | –            |
| Texte pro 24 h         | 20        | unbegrenzt   |
| Zeichen pro Text       | 20 000    | 20 000       |

Die Zahlen stehen als `LIMITS` oben in `src/index.js`.

Gezählt werden **begonnene** Uploads, nicht nur fertige – sonst könnte jemand
tausende gleichzeitig starten und die Zählung liefe hinterher. Angefangene,
nie beendete Uploads werden nach 24 Stunden aufgeräumt und geben ihren Platz
wieder frei.

## Testdateien

Jede Datei, die `tools/test-api.mjs` anlegt, heißt `TESTLAUF-…`, und
`tools/cleanup-tests.mjs` löscht ausschließlich solche. Alles andere listet es
auf und fasst es nicht an.

Das ist kein Übereifer: ein pauschales „Bucket leeren“ nach einem Testlauf hat
hier schon einmal einen echten Upload mitgenommen, und R2 hat keine
Versionierung – weg ist weg.

## Aufräumen

Ein Cron-Lauf um 4:07 UTC löscht Dateien, die älter als 14 Tage sind, aus R2
und aus der Datenbank; Texte bleiben 90 Tage. Beides steht in `LIMITS` als
`fileRetentionDays` und `noteRetentionDays`. In der Liste lässt sich außerdem
alles einzeln von Hand löschen.

Das ist keine Kosmetik: R2 rechnet nach liegendem Speicher ab. Ohne das
Aufräumen bliebe jede jemals geschickte Datei für immer liegen.

## Sicherheit

Der Kern: **der Browser entscheidet nichts.** Jede Grenze wird im Worker
geprüft, und `tools/test-api.mjs` versucht genau das zu umgehen.

- Das Limit hängt am Upload-Datensatz, nicht an der Anfrage. Wer 1 MB anmeldet
  und dann 5 MB schickt, wird beim Teilstück abgewiesen.
- Das Upload-Token liegt nur als SHA-256 in der Datenbank. Wer sie liest, kann
  keinen fremden Upload weiterschreiben.
- Ein 2FA-Code gilt genau einmal; das benutzte Zeitfenster wird gespeichert.
- Nach 10 Fehlversuchen ist eine IP für eine Stunde gesperrt.
- Sitzungstoken sind HMAC-signiert und laufen nach 6 Stunden ab. Sie liegen im
  `sessionStorage`, sind also mit dem Tab weg.
- Der Bucket ist **nicht** öffentlich. Dateien kommt nur heraus, wer einen
  gültigen Code hat, und nur über Schlüssel, die in der Datenbank stehen.
- Downloads gehen immer als `application/octet-stream` mit
  `Content-Disposition: attachment` raus. Sonst ließe sich hochgeladenes HTML
  unter upload.veerka.mp im Browser ausführen.
- Dateinamen werden von Steuerzeichen, Pfadtrennzeichen und `..` befreit,
  bevor sie in den Objektschlüssel wandern.
- Ein bereits benutzter 2FA-Code zählt **nicht** als Fehlversuch. Der Code war
  ja richtig – wer zweimal tippt, soll sich nicht selbst aussperren.

Das Cookie, das beim Freischalten gesetzt wird, gilt nur für `/api/files` –
es existiert allein, damit ein `<a href>` beim Download etwas mitschicken
kann. Alle anderen Routen verlangen den `Authorization`-Header, sonst wäre
das Cookie eine offene CSRF-Flanke.

## Einrichtung von Grund auf

```bash
npx wrangler r2 bucket create upload-veerka-mp
npx wrangler d1 create upload-meta            # database_id in wrangler.jsonc eintragen
npx wrangler d1 execute upload-meta --remote --file=schema.sql

# Secrets: TOTP_SECRET ist ein Base32-Schlüssel, SESSION_SECRET beliebig zufällig
npx wrangler secret put TOTP_SECRET
npx wrangler secret put SESSION_SECRET
```

Für lokale Tests dieselben zwei Werte in eine `.dev.vars` legen – die Datei
steht in `.gitignore` und gehört nirgendwo anders hin.

Ist `TOTP_SECRET` nicht gesetzt, verschwindet der Freischalt-Knopf und es
bleibt beim 50-MB-Limit.

## Kosten

R2 rechnet Speicher ab, kein Herunterladen. Die ersten 10 GB im Monat sind
frei, danach etwa 1,5 Cent pro GB und Monat. Eine einzelne 10-GB-Datei kostet
also rund 15 Cent im Monat, solange sie liegen bleibt – aufräumen lohnt sich.

## Deployment

Jeder Push auf `main` wird von Cloudflare Workers Builds gebaut und
veröffentlicht. Der Worker heißt `upload` – der Name in `wrangler.jsonc` muss
zu dem im Dashboard passen, sonst entsteht beim Build ein zweiter Worker.
