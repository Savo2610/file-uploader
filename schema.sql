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
