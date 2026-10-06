# Hinweise für Claude

## „Sag mir Bescheid über die Upload-Seite“

Der Besitzer hat kein AirDrop und nutzt diese Seite (`upload.veerka.mp`) als
Briefkasten. Er bekommt eine Push-Benachrichtigung aufs Handy, sobald etwas
eingeworfen wird (Cron minütlich, siehe README „Benachrichtigung, wenn etwas
ankommt“).

Wenn er sagt, du sollst ihn über die Upload-Seite informieren, ihm etwas
schicken oder ihm den Abschluss einer Aufgabe melden, dann ist genau das
gemeint: wirf einen kurzen Text in den Briefkasten. Er sieht ihn unter
`download.veerka.mp` in der Liste der Texte und bekommt dazu die
Benachrichtigung.

### So geht es

Texte brauchen keinen Login. Eine Zeile reicht:

```bash
curl -sS -X POST https://upload.veerka.mp/api/note \
  -H 'Content-Type: application/json' \
  -d '{"text":"Aufgabe XY ist fertig. Ergebnis: ..."}'
```

Antwort `{"ok":true}` heißt: liegt in D1 (Tabelle `notes`), Benachrichtigung
kommt innerhalb einer Minute.

- Maximal 20 000 Zeichen, anonym 20 Texte pro 24 h. Mehrere Meldungen kurz
  hintereinander lieber zu einer zusammenfassen.
- Schreib so, dass man es auf dem Handy in einem Blick versteht: was ist
  fertig, was ist das Ergebnis, was ist offen. Links zu PRs oder Artifacts
  gehören mit hinein.
- Keine Geheimnisse, Tokens oder Passwörter in den Text. Die Upload-Seite ist
  öffentlich, die Texte liegen im Klartext in der Datenbank.
- Meldung nur senden, wenn er darum gebeten hat oder eine lange Aufgabe
  ausdrücklich damit abgeschlossen werden soll. Nicht für jede Kleinigkeit.
- Dateien (Fotos, Dokumente) gehen über den Ablauf aus der README
  (`/api/upload/init`, `part`, `complete`), anonym bis 50 MB.
- Ist `upload.veerka.mp` aus der Umgebung nicht erreichbar (Proxy, Netzwerk),
  sag es ihm im Chat, statt es still zu überspringen.

### Schreibstil

Der Besitzer will in Texten, Mails und Briefen **nicht** das Zeichen „—“
(Gedankenstrich mit Leerzeichen) sehen. Das gilt auch für diese Meldungen.
