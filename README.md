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

npm test               # 102 Tests gegen beide
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
| `public/download.webmanifest` | macht die Abhol-Seite installierbar           |
| `public/sw.js`       | Service Worker der Abhol-Seite                         |
| `public/icons/`      | die Symbole für den Startbildschirm                    |
| `public/qr.svg`      | der QR-Code auf `upload.veerka.mp`                     |
| `src/index.js`       | die API, und welche Route unter welchem Host existiert |
| `src/crypto.js`      | TOTP nach RFC 6238 und signierte Sitzungstoken         |
| `src/push.js`        | Web Push: VAPID und die Verschlüsselung der Nutzlast    |
| `schema.sql`         | Tabellen für D1                                        |
| `tools/test-api.mjs` | 102 Tests, vor allem gegen Umgehungsversuche           |
| `tools/cleanup-tests.mjs` | räumt nur die Testdateien weg, nichts sonst      |
| `tools/make-icons.mjs` | zeichnet die Symbole in `public/icons/`              |
| `tools/make-qr.mjs`  | QR-Encoder nach ISO 18004, schreibt `public/qr.svg`    |
| `tools/make-vapid.mjs` | erzeugt einmalig das Schlüsselpaar für Web Push      |
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

## Alles abholen und leer räumen

Über den Listen stehen zwei Knöpfe. „Alles herunterladen“ holt jede Datei
einzeln und der Reihe nach; die Texte gehen als eine `Texte-und-Links.txt`
mit. Erst wenn **jede** Datei angekommen ist, erscheint „Alles löschen“.
Scheitert eine, bleibt der zweite Knopf weg und die Meldung nennt den Namen –
lieber nichts löschen als etwas, das nie ankam.

Der zweite Knopf schickt die Schlüssel mit, die der Browser vorher wirklich
geholt hat (`POST /api/purge`). Gelöscht wird genau das und nichts sonst: was
zwischen Herunterladen und Löschen ankommt, bleibt liegen. Ein „lösch alles,
was da ist“ hätte es mitgenommen, ohne dass es je jemand gesehen hätte.

Der Server prüft trotzdem jeden Schlüssel gegen die Datenbank – ein erfundener
trifft nichts. `/api/purge` gibt es nur unter der Abhol-Adresse.

Sequenziell und nicht als ZIP vom Server, weil das Archivformat eine Prüfsumme
über den ganzen Inhalt verlangt. Die müsste der Worker über jedes Byte rechnen,
und bei zehn Gigabyte reißt das die Rechenzeit-Grenze. Einzeln zu laden
kostet dafür einen Klick auf Chromes Rückfrage nach mehreren Downloads.

## Angemeldet bleiben

Auf der Abhol-Seite wird der Code aus der Authenticator-App nicht bei jedem
Öffnen verlangt. Die Sitzung dort gilt **30 Tage** statt der sechs Stunden auf
der Upload-Seite, und das Token liegt im `localStorage` statt im
`sessionStorage` – es überlebt also das Schließen des Tabs.

Dazu kommt eine gleitende Verlängerung: fragt die Seite den Zustand ab und ist
mehr als die Hälfte der Laufzeit herum, gibt der Server ein frisches Token
zurück. Wer die Seite alle paar Wochen benutzt, wird nie wieder nach einem Code
gefragt; wer sie einen Monat liegen lässt, schon.

Verlängert wird nur ein Token, das **noch gültig** ist – ein abgelaufenes kommt
gar nicht erst durch die Prüfung. Es gibt also keinen Weg an der 2FA vorbei,
nur einen Weg, sie nicht ständig zu wiederholen. Der Preis dafür: auf dem Gerät
liegt ein Schlüssel, der einen Monat lang gilt. Deshalb steht unten auf der
Seite „abmelden“ – das wirft Token und Cookie weg (`POST /api/logout`, denn das
Cookie ist `HttpOnly` und lässt sich vom Browser aus nicht löschen).

Die Unterscheidung macht der Client: nur die Abhol-Seite schickt beim
Freischalten `remember: true` mit. Auf der Upload-Seite steht man vor einem
fremden Gerät, dort bleibt es bei sechs Stunden.

Ein Login über Google wäre dafür nicht nötig gewesen: er würde dieselbe Frage
beantworten – wie lange darf eine Sitzung gelten – nur mit einem fremden
Anbieter, einer Liste erlaubter Konten und einem OAuth-Rückweg dazwischen.

## App auf dem Startbildschirm

`download.veerka.mp` lässt sich als App installieren und liegt dann mit
eigenem Symbol auf dem Startbildschirm. Dafür braucht es drei Dinge, und keins
davon ist optional:

- ein Manifest mit Name, Startadresse und Symbolen in **192 und 512 Pixel**
  als PNG (SVG reicht Android nicht),
- ein Symbol mit `purpose: "maskable"` – randlos, weil manche
  Startbildschirme bis zu 20 % ringsum wegschneiden,
- einen **Service Worker mit `fetch`-Behandlung**. Ohne ihn legt Android nur
  eine Verknüpfung an, und die trägt das Chrome-Logo in der Ecke.

Der Service Worker speichert ausschließlich das Gerüst der Seite – HTML, CSS,
Symbole. Alles unter `/api/` geht immer ans Netz und landet nie in einem
Cache: gespeicherte Antworten blieben sonst auf dem Gerät liegen, auch nachdem
die Sitzung abgelaufen oder die Datei gelöscht ist. Seitenaufrufe holt er zuerst
aus dem Netz, damit eine neue Fassung sofort ankommt; der Cache ist nur der
Rettungsanker ohne Verbindung.

Die Symbole liegen fertig im Repo. Ändern lassen sie sich mit
`node tools/make-icons.mjs` – das Skript zeichnet sie aus Abstandsfunktionen
und schreibt das PNG von Hand, damit für ein paar Quadrate kein Bildpaket im
Projekt hängt.

Manifest, Symbole und Service Worker gibt es nur unter der Abhol-Adresse; unter
`upload.veerka.mp` antworten sie mit 404, wie die Abhol-Seite selbst.

## QR-Code zum Herzeigen

Im Fuß der Abhol-Seite steht **QR zum Einwerfen**. Ein Tipp legt den Code groß
über die Seite: jemand hält sein Handy davor und landet auf `upload.veerka.mp`,
ohne die Adresse abzutippen.

Er zeigt bewusst auf die **Upload**-Adresse und nicht auf diese hier – er ist
zum Herzeigen da, damit ein anderer etwas einwerfen kann. Wer schon auf der
Abhol-Seite steht, braucht ihn nicht.

Gerechnet wird er nicht im Browser: die Adresse ändert sich nie, also liegt er
fertig als `public/qr.svg` im Repo. `npm run qr` zeichnet ihn neu.
`tools/make-qr.mjs` ist ein vollständiger Encoder nach ISO/IEC 18004
(Byte-Modus, Reed-Solomon über GF(256)), ohne Abhängigkeiten wie alles hier.

Wie Manifest, Symbole und Service Worker gehört `qr.svg` zum Zubehör der
Abhol-Adresse: unter `upload.veerka.mp` antwortet es mit 404.

## Benachrichtigung, wenn etwas ankommt

Unten auf der Abhol-Seite steht „Benachrichtigungen an“. Danach meldet sich das
Handy, sobald jemand etwas eingeworfen hat – über Web Push, ohne fremden Dienst
und ohne App.

Der Weg dorthin führt zwangsläufig über den Push-Dienst des jeweiligen
Browserherstellers; direkt aufs Gerät kann niemand zustellen. Lesen kann er die
Nachricht aber nicht: sie ist nach RFC 8291 für genau ein Gerät verschlüsselt.
Google sieht, dass etwas unterwegs ist, nicht den Dateinamen.

Drei Teile, alle in `src/push.js`, alle über WebCrypto und ohne Abhängigkeit:

- **VAPID** (RFC 8292) – ein ES256-signiertes JWT pro Zustellung. Ohne das
  nimmt kein Push-Dienst etwas an.
- **Verschlüsselung** (RFC 8291 über RFC 8188) – ECDH mit einem frischen
  Wegwerf-Schlüssel je Nachricht, HKDF, AES-128-GCM.
- **Zustellung** – ein POST an die Adresse aus dem Abo. `404` und `410` heißen:
  das Gerät hat das Abo weggeworfen, die Zeile kann weg.

### Warum minütlich statt beim Upload

Benachrichtigt wird nicht beim Hochladen, sondern von einem Cron jede Minute.
Der Grund ist der Normalfall: wer fünf Fotos auf einmal schickt, soll einmal
„5 Dateien angekommen“ lesen und nicht fünfmal klingeln. Der Lauf schaut nach,
was seit der letzten Meldung dazugekommen ist, und schickt genau eine
Nachricht. Der Preis ist bis zu eine Minute Verzögerung – für einen Briefkasten
belanglos.

Ohne angemeldetes Gerät endet der Lauf nach einer einzigen Abfrage, ohne
Schreibzugriff. Das ist der Normalfall, 1440-mal am Tag.

Die Marke `last_push` sagt, bis wohin schon gemeldet wurde. Sie wird beim
**ersten** Abo auf „jetzt“ gesetzt – sonst käme beim Einschalten alles nach,
was ohnehin schon im Briefkasten liegt.

### Einrichten

```bash
node tools/make-vapid.mjs        # gibt beide Schlüssel aus
npx wrangler secret put VAPID_PUBLIC
npx wrangler secret put VAPID_PRIVATE
```

Ohne diese zwei Secrets verschwindet der Schalter und der Cron-Lauf tut nichts.
Ein neues Schlüsselpaar macht alle bestehenden Abos ungültig; dann muss jedes
Gerät die Benachrichtigungen einmal neu einschalten.

Auf dem iPhone gibt es Web Push **nur**, wenn die Seite vom Startbildschirm
gestartet wurde – im normalen Safari-Tab existiert `Notification` schlicht
nicht. Steht die Seite dort nicht, zeigt der Fuß statt des Schalters den
Hinweis, sie hinzuzufügen.

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
- Sitzungstoken sind HMAC-signiert und tragen ihr Ablaufdatum in sich. Auf der
  Upload-Seite gelten sie 6 Stunden und liegen im `sessionStorage`, sind also
  mit dem Tab weg; auf der Abhol-Seite 30 Tage im `localStorage`. Verlängert
  wird nur, was noch gültig ist – siehe „Angemeldet bleiben“.
- Der Bucket ist **nicht** öffentlich. Dateien kommt nur heraus, wer einen
  gültigen Code hat, und nur über Schlüssel, die in der Datenbank stehen.
- Auch das Sammellöschen fasst nur Schlüssel an, die in der Datenbank stehen
  und zu einem fertigen Upload gehören – und nur die, die der Browser
  ausdrücklich mitschickt. Es gibt keinen Aufruf, der „den Rest“ löscht.
- Benachrichtigungen bekommt nur, wer freigeschaltet ist. Die Adresse, an die
  zugestellt wird, muss `https` sein – sonst ließe sich der Worker als Bote für
  beliebige Ziele benutzen.
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
das Cookie eine offene CSRF-Flanke. Es ist `HttpOnly` und `SameSite=Strict`
und hält genauso lange wie das Token, zu dem es gehört.

## Einrichtung von Grund auf

```bash
npx wrangler r2 bucket create upload-veerka-mp
npx wrangler d1 create upload-meta            # database_id in wrangler.jsonc eintragen
npx wrangler d1 execute upload-meta --remote --file=schema.sql

# Secrets: TOTP_SECRET ist ein Base32-Schlüssel, SESSION_SECRET beliebig zufällig
npx wrangler secret put TOTP_SECRET
npx wrangler secret put SESSION_SECRET

# Optional, für Benachrichtigungen – siehe oben
node tools/make-vapid.mjs
npx wrangler secret put VAPID_PUBLIC
npx wrangler secret put VAPID_PRIVATE
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
