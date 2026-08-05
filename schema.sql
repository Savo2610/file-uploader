-- Schema für upload.veerka.mp
--
-- Einspielen:
--   npx wrangler d1 execute upload-meta --local  --file=schema.sql
--   npx wrangler d1 execute upload-meta --remote --file=schema.sql

-- Ein Datensatz pro Upload-Vorgang. Dient drei Zwecken: er hält den Zustand
-- eines laufenden Multipart-Uploads, er erzwingt das zugesagte Limit über alle
-- Teil-Anfragen hinweg, und er ist hinterher das Protokoll, wer wann was
-- geschickt hat.
CREATE TABLE IF NOT EXISTS uploads (
  -- SHA-256 des Upload-Tokens, nicht das Token selbst. Wer die Datenbank
  -- liest, kann damit keinen fremden Upload weiterschreiben.
  token_hash   TEXT PRIMARY KEY,
  r2_key       TEXT NOT NULL,
  file_name    TEXT NOT NULL,
  content_type TEXT NOT NULL,
  -- Beim Start angemeldete Größe. Jede Teil-Anfrage wird dagegen geprüft.
  size         INTEGER NOT NULL,
  received     INTEGER NOT NULL DEFAULT 0,
  part_size    INTEGER NOT NULL,
  multipart_id TEXT NOT NULL,
  -- 1, wenn der Upload mit gültigem 2FA-Token gestartet wurde. Die Entscheidung
  -- fällt einmal beim Start und hängt danach am Upload, nicht an der Sitzung –
  -- sonst würde ein 10-GB-Upload mitten drin am Sitzungsablauf scheitern.
  elevated     INTEGER NOT NULL DEFAULT 0,
  ip           TEXT,
  created_at   INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS uploads_completed_at ON uploads (completed_at);
CREATE INDEX IF NOT EXISTS uploads_created_at   ON uploads (created_at);

-- Verbrauchte 2FA-Codes. Ein Code ist 30 Sekunden gültig und würde in diesem
-- Fenster sonst mehrfach funktionieren – wer ihn abfängt, käme damit rein.
CREATE TABLE IF NOT EXISTS totp_used (
  code       TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

-- Fehlversuche bei der Freischaltung, gegen Durchprobieren der 6 Stellen.
CREATE TABLE IF NOT EXISTS auth_attempts (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  ip   TEXT NOT NULL,
  ok   INTEGER NOT NULL,
  at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS auth_attempts_at ON auth_attempts (at);
CREATE INDEX IF NOT EXISTS auth_attempts_ip ON auth_attempts (ip, at);

-- Eingefügter Text und Links. Bewusst direkt in der Datenbank und nicht als
-- Datei in R2: so lässt sich der Inhalt auf dem Handy sofort lesen und
-- kopieren, ohne vorher etwas herunterzuladen.
CREATE TABLE IF NOT EXISTS notes (
  id         TEXT PRIMARY KEY,
  text       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ip         TEXT
);

CREATE INDEX IF NOT EXISTS notes_created_at ON notes (created_at);

-- Geräte, die eine Benachrichtigung bekommen, wenn etwas ankommt. Ein Eintrag
-- je Browser und Gerät. Die Adresse zeigt auf den Push-Dienst des jeweiligen
-- Herstellers und ist gleichzeitig der Schlüssel: meldet sich dasselbe Gerät
-- erneut an, ersetzt der Eintrag den alten.
--
-- p256dh und auth gehören dem Gerät. Mit ihnen wird die Nachricht so
-- verschlüsselt, dass nur dieses eine Gerät sie lesen kann – der Push-Dienst
-- dazwischen sieht nur, dass etwas unterwegs ist.
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint   TEXT PRIMARY KEY,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Bis wohin wurde schon benachrichtigt. Ohne diese Marke käme beim ersten Lauf
-- alles nach, was jemals hochgeladen wurde.
CREATE TABLE IF NOT EXISTS push_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
