# upload.veerka.mp

Ein Briefkasten zum Hochladen von Dateien. Eine Seite, keine Build-Tools.
Liegt als Worker mit statischen Assets bei Cloudflare, das Repo bleibt hier
auf GitHub.

```bash
npm run dev       # lokal auf http://localhost:8787
npm run deploy    # von Hand nach upload.veerka.mp
```

## Struktur

| Pfad                    | Was drin ist                                          |
| ----------------------- | ----------------------------------------------------- |
| `public/index.html`     | die komplette Seite – HTML, CSS und JS in einer Datei  |
| `public/_headers`       | Cache- und Sicherheits-Header                          |
| `wrangler.jsonc`        | Worker-Name und Domain                                 |
| `TEXT_INPUT_FEATURE.md` | Notiz zu einer noch nicht gebauten Idee                |

## Wie der Upload läuft

Der Browser liest die Datei, wandelt sie in Base64 um und schickt sie als
JSON an ein Google Apps Script (`APPS_SCRIPT_URL` oben im `<script>`-Block).
Das Skript legt die Datei im Drive ab. Cloudflare liefert nur die Seite aus
und sieht die Dateien nie.

Zwei Eigenheiten, die man kennen muss, bevor man daran etwas ändert:

- **Kein `Content-Type` am `fetch` setzen.** Sobald ein Header gesetzt ist,
  verlangt der Browser einen CORS-Preflight (`OPTIONS`), den Apps Script nicht
  beantwortet – der Upload schlägt dann fehl.
- **Kein Fortschritt in Prozent beim Senden.** Den könnte nur
  `XMLHttpRequest.upload` liefern, aber ein Listener darauf löst denselben
  Preflight aus. Deshalb läuft während des Sendens eine Endlos-Animation
  statt einer Prozentanzeige.

### Größenlimit

Apps Script nimmt pro Anfrage rund 50 MB entgegen, und Base64 bläht eine Datei
um etwa ein Drittel auf. Real passen also grob **35 MB** durch. Das im
Frontend eingestellte Limit (`LIMIT_NORMAL_MB`) steht höher, und das per
Passwort freischaltbare Limit von 10 GB kann gar nicht funktionieren: Base64
läuft komplett durch den Arbeitsspeicher des Browsers und reißt weit vorher
ab. Wer wirklich große Dateien braucht, muss den Weg über Apps Script
ersetzen – etwa durch einen Upload direkt nach R2.

## Deployment

Jeder Push auf `main` wird von Cloudflare Workers Builds gebaut und
veröffentlicht. Der Worker heißt `upload` – der Name in `wrangler.jsonc` muss
zu dem im Dashboard passen, sonst entsteht beim Build ein zweiter Worker.

Die Domain `upload.veerka.mp` hängt als Custom Domain am Worker und steht in
`wrangler.jsonc`.
