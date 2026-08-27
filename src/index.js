import {
  randomToken, sha256Hex, verifyTotp, signSession, verifySession,
} from './crypto.js';
import { senden } from './push.js';

// ── Stellschrauben ──────────────────────────────────────────────────────────

const LIMITS = {
  // Ohne Freischaltung: pro Datei …
  anonMaxFileBytes: 50 * 1024 * 1024,          // 50 MB
  // … und insgesamt so viele Dateien in 24 Stunden. Gezählt werden begonnene
  // Uploads, nicht nur fertige – sonst könnte jemand tausende parallel starten
  // und die Zählung liefe hinterher.
  anonMaxFilesPerDay: 50,
  // Zusätzliche Bremse pro Absender, damit nicht einer allein das Tages-
  // kontingent für alle anderen aufbraucht.
  anonMaxFilesPerDayPerIp: 30,

  // Nach erfolgreichem 2FA-Code: pro Datei …
  elevatedMaxFileBytes: 10 * 1024 * 1024 * 1024, // 10 GB
  // … ohne Stückzahlbegrenzung.

  // Gültigkeit des Tokens, das man nach dem 2FA-Code bekommt.
  sessionTtlSeconds: 6 * 60 * 60,

  // Dasselbe, wenn beim Freischalten „angemeldet bleiben“ mitgeschickt wird –
  // das tut die Abhol-Seite. Der Code aus der Authenticator-App bleibt der
  // einzige Weg hinein; er wird nur nicht mehr bei jedem Öffnen verlangt.
  rememberTtlSeconds: 30 * 24 * 60 * 60,

  // Ab wann ein Token beim Nachfragen des Zustands gegen ein frisches getauscht
  // wird: sobald weniger als dieser Anteil der Laufzeit übrig ist. Wer die
  // Seite regelmäßig benutzt, kommt so nie an den Ablauf – wer sie einen Monat
  // liegen lässt, braucht wieder einen Code.
  renewBelow: 0.5,

  // Fehlversuche bei der Freischaltung, bevor die IP für eine Stunde gesperrt
  // wird. Ohne das ließen sich 6 Stellen in überschaubarer Zeit durchprobieren.
  maxAuthFailuresPerHour: 10,

  // Eingefügter Text: Länge und Stückzahl pro Tag.
  maxNoteChars: 20_000,
  anonMaxNotesPerDay: 20,

  // Nach so vielen Tagen räumt der nächtliche Lauf auf. R2 rechnet nach
  // liegendem Speicher ab – was weg ist, kostet nichts mehr.
  fileRetentionDays: 14,
  noteRetentionDays: 90,
};

// Größe eines Teilstücks beim Hochladen. Jedes Teil geht als eigene Anfrage
// durch den Worker und wird dort komplett im Speicher gehalten – deshalb
// bewusst klein: bei drei parallelen Teilen sind das 30 MB von 128 MB, die
// einem Worker zur Verfügung stehen. 10 GB ergeben damit 1024 Teile, das
// R2-Maximum liegt bei 10.000.
const PART_SIZE = 10 * 1024 * 1024;

const DAY_MS  = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// Muss wörtlich mit dem Eintrag in wrangler.jsonc übereinstimmen: daran
// erkennt der scheduled-Handler, welcher der beiden Läufe ihn gerufen hat.
const CRON_AUFRAEUMEN = '7 4 * * *';

// ── Antwort-Hilfen ──────────────────────────────────────────────────────────

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cache-Control': 'no-store',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS },
  });
}

const fail = (status, message) => json({ error: message }, status);

// ── Eingaben säubern ────────────────────────────────────────────────────────

// Der Dateiname kommt vom Absender und darf nichts anderes werden als ein
// Name: keine Pfadtrennzeichen, keine Steuerzeichen, keine Ausbrüche nach oben.
function safeFileName(raw) {
  const name = String(raw ?? '')
    .replace(/[\x00-\x1f\x7f]/g, '')  // Steuerzeichen
    .replace(/[\\/]/g, '_')           // Pfadtrennzeichen
    .replace(/\.{2,}/g, '.')          // kein ".." mehr, auch nicht in der Mitte
    .replace(/^[.\s_]+/, '')          // nichts Verstecktes am Anfang
    .trim();
  return name.slice(0, 180) || 'unbenannt';
}

function safeContentType(raw) {
  const t = String(raw ?? '').replace(/[^\w.+/-]/g, '').slice(0, 100);
  return t || 'application/octet-stream';
}

function objectKey(fileName) {
  const d = new Date();
  const day = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
  return `${day}/${randomToken(6)}-${safeFileName(fileName)}`;
}

const clientIp = request => request.headers.get('CF-Connecting-IP') || 'unbekannt';

// ── Berechtigung ────────────────────────────────────────────────────────────

// Liefert den Inhalt eines gültigen Sitzungstokens – oder null.
//
// Normalfall ist der Authorization-Header, den das Skript der Seite setzt.
// Das Cookie wird nur dort akzeptiert, wo es sein muss – beim Download, weil
// ein <a href> keinen Header mitschicken kann. Überall sonst bliebe es eine
// offene Flanke für CSRF: ein Cookie schickt der Browser auch dann mit, wenn
// eine fremde Seite die Anfrage auslöst.
async function readSession(request, env, { allowCookie = false } = {}) {
  if (!env.SESSION_SECRET) return null;

  const header = request.headers.get('Authorization') || '';
  let token = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!token && allowCookie) {
    const cookie = request.headers.get('Cookie') || '';
    token = /(?:^|;\s*)session=([^;]+)/.exec(cookie)?.[1] ?? '';
  }

  if (!token) return null;
  return verifySession(env.SESSION_SECRET, token);
}

// Für alle Stellen, die nur wissen wollen, ob freigeschaltet ist.
const isElevated = (request, env, opts) =>
  readSession(request, env, opts).then(Boolean);

// Das Cookie zum Sitzungstoken. Gilt bewusst nur für /api/files – es existiert
// allein, damit ein Download-Link etwas mitschicken kann, siehe readSession().
function setSessionCookie(response, request, token, maxAge) {
  const secure = new URL(request.url).protocol === 'https:' ? ' Secure;' : '';
  response.headers.append(
    'Set-Cookie',
    `session=${token}; Path=/api/files;${secure} HttpOnly; SameSite=Strict; Max-Age=${maxAge}`,
  );
  return response;
}

// ── Aufräumen ───────────────────────────────────────────────────────────────

// Angefangene, nie beendete Uploads blockieren sonst dauerhaft Kontingent und
// belegen in R2 Speicher. Läuft beiläufig bei jedem Upload-Start mit.
async function cleanup(env) {
  const now = Date.now();
  const stale = await env.DB
    .prepare('SELECT r2_key, multipart_id FROM uploads WHERE completed_at IS NULL AND created_at < ?')
    .bind(now - DAY_MS)
    .all();

  for (const row of stale.results ?? []) {
    try {
      await env.BUCKET.resumeMultipartUpload(row.r2_key, row.multipart_id).abort();
    } catch {
      // Schon weg oder nie angelegt – dann ist nichts zu tun.
    }
  }

  await env.DB.batch([
    env.DB.prepare('DELETE FROM uploads WHERE completed_at IS NULL AND created_at < ?').bind(now - DAY_MS),
    env.DB.prepare('DELETE FROM totp_used WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM auth_attempts WHERE at < ?').bind(now - DAY_MS),
  ]);
}

// ── Route: Zustand ──────────────────────────────────────────────────────────

async function handleStatus(request, env) {
  const session  = await readSession(request, env);
  const elevated = Boolean(session);

  const used = await env.DB
    .prepare('SELECT COUNT(*) AS n FROM uploads WHERE elevated = 0 AND created_at > ?')
    .bind(Date.now() - DAY_MS)
    .first();

  // Gleitende Verlängerung: ist mehr als die Hälfte der Laufzeit herum, gibt
  // es hier ein frisches Token. Dadurch bleibt angemeldet, wer die Seite
  // benutzt, ohne dass ein einzelnes Token unbegrenzt lange gilt.
  //
  // Kein Nachschlüssel: verlängert wird nur ein Token, das gerade noch gültig
  // ist. Ein abgelaufenes kommt hier gar nicht erst an.
  let renewed = null;
  if (session?.ttl) {
    const uebrig = session.exp - Math.floor(Date.now() / 1000);
    if (uebrig < session.ttl * LIMITS.renewBelow) {
      renewed = await signSession(env.SESSION_SECRET, session.ttl);
    }
  }

  const response = json({
    elevated,
    maxFileBytes: elevated ? LIMITS.elevatedMaxFileBytes : LIMITS.anonMaxFileBytes,
    elevatedMaxFileBytes: LIMITS.elevatedMaxFileBytes,
    partSize: PART_SIZE,
    filesPerDay: LIMITS.anonMaxFilesPerDay,
    filesRemainingToday: elevated ? null : Math.max(0, LIMITS.anonMaxFilesPerDay - (used?.n ?? 0)),
    twoFactorConfigured: Boolean(env.TOTP_SECRET && env.SESSION_SECRET),
    maxNoteChars: LIMITS.maxNoteChars,
    retentionDays: LIMITS.fileRetentionDays,
    // Der öffentliche Teil des VAPID-Schlüssels ist zum Herzeigen gedacht –
    // der Browser braucht ihn, um sich beim Push-Dienst anzumelden.
    pushPublicKey: pushEingerichtet(env) ? env.VAPID_PUBLIC : null,
    // Nur gesetzt, wenn eben verlängert wurde – sonst gar nicht erst im Feld.
    ...(renewed ? { token: renewed, expiresIn: session.ttl } : {}),
    // Damit die Seite sagen kann, bis wann sie ohne Code auskommt.
    ...(session ? { sessionExpiresAt: session.exp * 1000 } : {}),
  });

  return renewed ? setSessionCookie(response, request, renewed, session.ttl) : response;
}

// ── Route: Text und Links ───────────────────────────────────────────────────

async function handleNote(request, env) {
  let body;
  try { body = await request.json(); } catch { return fail(400, 'Ungültige Anfrage.'); }

  const text = String(body?.text ?? '').trim();
  if (!text) return fail(400, 'Kein Text angekommen.');
  if (text.length > LIMITS.maxNoteChars) {
    return fail(413, `Der Text ist zu lang (max. ${LIMITS.maxNoteChars} Zeichen).`);
  }

  const ip = clientIp(request);
  const now = Date.now();

  if (!(await isElevated(request, env))) {
    const used = await env.DB
      .prepare('SELECT COUNT(*) AS n FROM notes WHERE created_at > ?')
      .bind(now - DAY_MS)
      .first();
    if ((used?.n ?? 0) >= LIMITS.anonMaxNotesPerDay) {
      return fail(429, 'Heute wurden schon viele Texte geschickt. Morgen wieder.');
    }
  }

  await env.DB
    .prepare('INSERT INTO notes (id, text, created_at, ip) VALUES (?, ?, ?, ?)')
    .bind(randomToken(9), text, now, ip)
    .run();

  return json({ ok: true });
}

async function handleNotesList(request, env) {
  if (!(await isElevated(request, env))) return fail(401, 'Nicht freigeschaltet.');

  const rows = await env.DB
    .prepare('SELECT id, text, created_at FROM notes ORDER BY created_at DESC LIMIT 100')
    .all();

  return json({
    notes: (rows.results ?? []).map(r => ({ id: r.id, text: r.text, createdAt: r.created_at })),
  });
}

async function handleNoteDelete(request, env, url) {
  if (!(await isElevated(request, env))) return fail(401, 'Nicht freigeschaltet.');
  await env.DB.prepare('DELETE FROM notes WHERE id = ?').bind(url.searchParams.get('id') || '').run();
  return json({ ok: true });
}

// ── Route: Freischalten ─────────────────────────────────────────────────────

async function handleUnlock(request, env) {
  if (!env.TOTP_SECRET || !env.SESSION_SECRET) {
    return fail(503, 'Zwei-Faktor-Anmeldung ist auf dem Server nicht eingerichtet.');
  }

  const ip = clientIp(request);
  const now = Date.now();

  const failures = await env.DB
    .prepare('SELECT COUNT(*) AS n FROM auth_attempts WHERE ip = ? AND ok = 0 AND at > ?')
    .bind(ip, now - HOUR_MS)
    .first();

  if ((failures?.n ?? 0) >= LIMITS.maxAuthFailuresPerHour) {
    return fail(429, 'Zu viele Fehlversuche. Bitte in einer Stunde erneut probieren.');
  }

  let body;
  try { body = await request.json(); } catch { return fail(400, 'Ungültige Anfrage.'); }

  const match = await verifyTotp(env.TOTP_SECRET, body?.code);

  if (!match) {
    await env.DB.prepare('INSERT INTO auth_attempts (ip, ok, at) VALUES (?, 0, ?)').bind(ip, now).run();
    return fail(401, 'Code stimmt nicht.');
  }

  // Ein Code gilt 30 Sekunden und würde in diesem Fenster mehrfach
  // funktionieren. Der Primärschlüssel lässt das genau einmal zu.
  //
  // Das zählt bewusst NICHT als Fehlversuch: der Code war ja richtig. Wer
  // zweimal auf „Öffnen“ tippt oder die Seite neu lädt, landet hier – das
  // gegen die Brute-Force-Sperre zu rechnen würde einen aussperren, der alles
  // richtig gemacht hat. Gegen Durchprobieren hilft es ohnehin nicht.
  const used = `${match.counter}`;
  try {
    await env.DB
      .prepare('INSERT INTO totp_used (code, expires_at) VALUES (?, ?)')
      .bind(used, now + 2 * 60 * 1000)
      .run();
  } catch {
    return fail(401, 'Dieser Code wurde bereits benutzt. Bitte den nächsten abwarten.');
  }

  await env.DB.prepare('INSERT INTO auth_attempts (ip, ok, at) VALUES (?, 1, ?)').bind(ip, now).run();

  // Die Abhol-Seite bittet um eine lange Sitzung, die Upload-Seite nicht: dort
  // sitzt die Freischaltung an einem fremden Gerät, hier am eigenen.
  const ttl = body?.remember ? LIMITS.rememberTtlSeconds : LIMITS.sessionTtlSeconds;
  const token = await signSession(env.SESSION_SECRET, ttl);

  return setSessionCookie(json({
    token,
    expiresIn: ttl,
    maxFileBytes: LIMITS.elevatedMaxFileBytes,
  }), request, token, ttl);
}

// ── Route: Abmelden ─────────────────────────────────────────────────────────
//
// Das Token selbst wirft die Seite weg; das Cookie kann sie nicht anfassen,
// weil es HttpOnly ist. Dafür ist diese Route da.

function handleLogout(request) {
  const secure = new URL(request.url).protocol === 'https:' ? ' Secure;' : '';
  const response = json({ ok: true });
  response.headers.append(
    'Set-Cookie',
    `session=; Path=/api/files;${secure} HttpOnly; SameSite=Strict; Max-Age=0`,
  );
  return response;
}

// ── Route: Upload starten ───────────────────────────────────────────────────

async function handleInit(request, env, ctx) {
  let body;
  try { body = await request.json(); } catch { return fail(400, 'Ungültige Anfrage.'); }

  const size = Number(body?.size);
  if (!Number.isSafeInteger(size) || size < 0) return fail(400, 'Ungültige Dateigröße.');

  const elevated = await isElevated(request, env);
  const maxBytes = elevated ? LIMITS.elevatedMaxFileBytes : LIMITS.anonMaxFileBytes;

  if (size > maxBytes) {
    return fail(413, elevated
      ? 'Diese Datei ist größer als 10 GB.'
      : 'Diese Datei ist größer als 50 MB. Mit einem 2FA-Code sind bis zu 10 GB möglich.');
  }

  const ip = clientIp(request);
  const now = Date.now();

  if (!elevated) {
    const [total, perIp] = await env.DB.batch([
      env.DB.prepare('SELECT COUNT(*) AS n FROM uploads WHERE elevated = 0 AND created_at > ?')
        .bind(now - DAY_MS),
      env.DB.prepare('SELECT COUNT(*) AS n FROM uploads WHERE elevated = 0 AND ip = ? AND created_at > ?')
        .bind(ip, now - DAY_MS),
    ]);

    if ((total.results?.[0]?.n ?? 0) >= LIMITS.anonMaxFilesPerDay) {
      return fail(429, 'Das Tageskontingent ist aufgebraucht. Morgen wieder – oder mit 2FA-Code.');
    }
    if ((perIp.results?.[0]?.n ?? 0) >= LIMITS.anonMaxFilesPerDayPerIp) {
      return fail(429, 'Du hast heute schon viele Dateien geschickt. Morgen wieder – oder mit 2FA-Code.');
    }
  }

  const fileName = safeFileName(body?.fileName);
  const contentType = safeContentType(body?.contentType);
  const key = objectKey(fileName);

  const multipart = await env.BUCKET.createMultipartUpload(key, {
    httpMetadata: { contentType },
  });

  const token = randomToken();
  await env.DB.prepare(`
    INSERT INTO uploads
      (token_hash, r2_key, file_name, content_type, size, part_size, multipart_id, elevated, ip, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    await sha256Hex(token), key, fileName, contentType,
    size, PART_SIZE, multipart.uploadId, elevated ? 1 : 0, ip, now,
  ).run();

  ctx.waitUntil(cleanup(env).catch(() => {}));

  return json({
    upload: token,
    partSize: PART_SIZE,
    partCount: Math.max(1, Math.ceil(size / PART_SIZE)),
  });
}

// Holt den Upload-Datensatz zum mitgeschickten Token.
async function loadUpload(env, token) {
  if (!token) return null;
  return env.DB
    .prepare('SELECT * FROM uploads WHERE token_hash = ?')
    .bind(await sha256Hex(String(token)))
    .first();
}

// ── Route: Teilstück hochladen ──────────────────────────────────────────────

async function handlePart(request, env, url) {
  const row = await loadUpload(env, url.searchParams.get('upload'));
  if (!row) return fail(404, 'Unbekannter Upload.');
  if (row.completed_at) return fail(409, 'Dieser Upload ist bereits abgeschlossen.');

  const partNumber = Number(url.searchParams.get('part'));
  const partCount = Math.max(1, Math.ceil(row.size / row.part_size));
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > partCount) {
    return fail(400, 'Ungültige Teilnummer.');
  }

  const data = await request.arrayBuffer();

  // Alle Teile außer dem letzten müssen exakt die vereinbarte Größe haben –
  // sonst nimmt R2 sie beim Zusammensetzen nicht an. Gleichzeitig ist das die
  // Stelle, an der die beim Start angemeldete Größe wirklich erzwungen wird:
  // ohne diese Prüfung könnte jemand einen 1-MB-Upload anmelden und dann
  // beliebig viele Daten nachschieben.
  const expected = partNumber < partCount
    ? row.part_size
    : row.size - row.part_size * (partCount - 1);

  if (data.byteLength !== expected) {
    return fail(400, `Teil ${partNumber} hat ${data.byteLength} Bytes, erwartet waren ${expected}.`);
  }

  const part = await env.BUCKET
    .resumeMultipartUpload(row.r2_key, row.multipart_id)
    .uploadPart(partNumber, data);

  await env.DB
    .prepare('UPDATE uploads SET received = received + ? WHERE token_hash = ?')
    .bind(data.byteLength, row.token_hash)
    .run();

  return json({ partNumber: part.partNumber, etag: part.etag });
}

// ── Route: Upload abschließen ───────────────────────────────────────────────

async function handleComplete(request, env) {
  let body;
  try { body = await request.json(); } catch { return fail(400, 'Ungültige Anfrage.'); }

  const row = await loadUpload(env, body?.upload);
  if (!row) return fail(404, 'Unbekannter Upload.');
  if (row.completed_at) return fail(409, 'Dieser Upload ist bereits abgeschlossen.');

  const parts = Array.isArray(body?.parts) ? body.parts : [];
  const partCount = Math.max(1, Math.ceil(row.size / row.part_size));
  if (parts.length !== partCount) return fail(400, 'Es fehlen Teilstücke.');

  try {
    await env.BUCKET
      .resumeMultipartUpload(row.r2_key, row.multipart_id)
      .complete(parts.map(p => ({ partNumber: Number(p.partNumber), etag: String(p.etag) })));
  } catch (err) {
    return fail(400, 'Zusammensetzen fehlgeschlagen: ' + (err?.message || 'unbekannter Fehler'));
  }

  await env.DB
    .prepare('UPDATE uploads SET completed_at = ? WHERE token_hash = ?')
    .bind(Date.now(), row.token_hash)
    .run();

  return json({ ok: true, fileName: row.file_name, size: row.size });
}

// ── Route: Upload abbrechen ─────────────────────────────────────────────────

async function handleAbort(request, env) {
  let body;
  try { body = await request.json(); } catch { return fail(400, 'Ungültige Anfrage.'); }

  const row = await loadUpload(env, body?.upload);
  if (!row) return json({ ok: true });
  if (row.completed_at) return fail(409, 'Dieser Upload ist bereits abgeschlossen.');

  try { await env.BUCKET.resumeMultipartUpload(row.r2_key, row.multipart_id).abort(); } catch { /* egal */ }
  await env.DB.prepare('DELETE FROM uploads WHERE token_hash = ?').bind(row.token_hash).run();
  return json({ ok: true });
}

// ── Routen: Dateien ansehen und holen (nur mit 2FA) ─────────────────────────

async function handleList(request, env) {
  if (!(await isElevated(request, env))) return fail(401, 'Nicht freigeschaltet.');

  const rows = await env.DB.prepare(`
    SELECT r2_key, file_name, size, completed_at
    FROM uploads
    WHERE completed_at IS NOT NULL
    ORDER BY completed_at DESC
    LIMIT 200
  `).all();

  return json({
    files: (rows.results ?? []).map(r => ({
      key: r.r2_key, name: r.file_name, size: r.size, uploadedAt: r.completed_at,
    })),
  });
}

async function handleDownload(request, env, url) {
  if (!(await isElevated(request, env, { allowCookie: true }))) return fail(401, 'Nicht freigeschaltet.');

  const key = url.searchParams.get('key') || '';
  // Nur Schlüssel aus der eigenen Datenbank – kein Herumraten im Bucket.
  const row = await env.DB
    .prepare('SELECT file_name FROM uploads WHERE r2_key = ? AND completed_at IS NOT NULL')
    .bind(key)
    .first();
  if (!row) return fail(404, 'Datei nicht gefunden.');

  const object = await env.BUCKET.get(key);
  if (!object) return fail(404, 'Datei nicht gefunden.');

  // Bewusst immer als Download und nie mit dem ursprünglichen Content-Type:
  // sonst ließe sich hochgeladenes HTML oder JavaScript unter upload.veerka.mp
  // im Browser ausführen.
  const asciiName = row.file_name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(object.size),
      'Content-Disposition':
        `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(row.file_name)}`,
      ...SECURITY_HEADERS,
    },
  });
}

async function handleFileDelete(request, env, url) {
  if (!(await isElevated(request, env))) return fail(401, 'Nicht freigeschaltet.');

  const key = url.searchParams.get('key') || '';
  const row = await env.DB
    .prepare('SELECT r2_key FROM uploads WHERE r2_key = ? AND completed_at IS NOT NULL')
    .bind(key)
    .first();
  if (!row) return fail(404, 'Datei nicht gefunden.');

  await env.BUCKET.delete(key);
  await env.DB.prepare('DELETE FROM uploads WHERE r2_key = ?').bind(key).run();
  return json({ ok: true });
}

// ── Route: Das Heruntergeladene löschen ─────────────────────────────────────
//
// Bewusst kein „lösch alles, was da ist“: der Browser schickt die Schlüssel
// mit, die er vorher wirklich geholt hat. Zwischen Herunterladen und Löschen
// kann etwas Neues angekommen sein – das wäre sonst weg, ohne dass es je
// jemand gesehen hätte. R2 hat keine Versionierung, weg ist weg.
//
// Der Browser entscheidet damit nicht mehr als vorher: gelöscht wird nur, was
// ohnehin in der Datenbank steht und fertig hochgeladen ist. Ein erfundener
// Schlüssel trifft nichts.

// So viele Einträge nimmt ein Aufruf entgegen – dieselbe Größenordnung wie die
// Listen, die die Seite überhaupt anzeigt.
const MAX_LOESCHEN = 500;

async function handlePurge(request, env) {
  if (!(await isElevated(request, env))) return fail(401, 'Nicht freigeschaltet.');

  let body;
  try { body = await request.json(); } catch { return fail(400, 'Ungültige Anfrage.'); }

  const gewuenscht = feld => {
    const roh = Array.isArray(body?.[feld]) ? body[feld] : [];
    return new Set(roh.slice(0, MAX_LOESCHEN).map(String));
  };

  const keys    = gewuenscht('keys');
  const noteIds = gewuenscht('noteIds');
  if (!keys.size && !noteIds.size) return fail(400, 'Nichts angegeben, was gelöscht werden soll.');

  const [dateien, texte] = await env.DB.batch([
    env.DB.prepare('SELECT r2_key FROM uploads WHERE completed_at IS NOT NULL'),
    env.DB.prepare('SELECT id FROM notes'),
  ]);

  const zuLoeschen = (dateien.results ?? []).map(r => r.r2_key).filter(k => keys.has(k));
  const texteWeg   = (texte.results ?? []).map(r => r.id).filter(id => noteIds.has(id));

  if (zuLoeschen.length) {
    // R2 nimmt bis zu 1000 Schlüssel auf einmal, mehr als MAX_LOESCHEN sind es nie.
    await env.BUCKET.delete(zuLoeschen);
  }

  // Je ein Statement pro Eintrag statt einer langen IN-Liste: D1 begrenzt die
  // Zahl der gebundenen Werte pro Anfrage, die Zahl der Statements im Stapel
  // ist das kleinere Problem.
  const statements = [
    ...zuLoeschen.map(k  => env.DB.prepare('DELETE FROM uploads WHERE r2_key = ?').bind(k)),
    ...texteWeg.map(id   => env.DB.prepare('DELETE FROM notes WHERE id = ?').bind(id)),
  ];
  for (let i = 0; i < statements.length; i += 50) {
    await env.DB.batch(statements.slice(i, i + 50));
  }

  return json({ ok: true, files: zuLoeschen.length, notes: texteWeg.length });
}

// ── Routen: Benachrichtigungen ──────────────────────────────────────────────
//
// Nur mit Freischaltung: wer benachrichtigt wird, wenn hier etwas ankommt,
// soll nicht davon abhängen, wer die Adresse kennt.

const pushEingerichtet = env => Boolean(env.VAPID_PUBLIC && env.VAPID_PRIVATE);

async function handlePushSubscribe(request, env) {
  if (!(await isElevated(request, env))) return fail(401, 'Nicht freigeschaltet.');
  if (!pushEingerichtet(env)) return fail(503, 'Benachrichtigungen sind auf dem Server nicht eingerichtet.');

  let body;
  try { body = await request.json(); } catch { return fail(400, 'Ungültige Anfrage.'); }

  const endpoint = String(body?.endpoint ?? '');
  const p256dh   = String(body?.p256dh ?? '');
  const auth     = String(body?.auth ?? '');

  // Die Adresse kommt vom Browser und wird angefragt, sobald etwas ankommt.
  // Ohne diese Prüfung ließe sich der Worker als Bote für beliebige Ziele
  // benutzen.
  let ziel;
  try { ziel = new URL(endpoint); } catch { return fail(400, 'Unbrauchbare Adresse.'); }
  if (ziel.protocol !== 'https:') return fail(400, 'Unbrauchbare Adresse.');
  if (!p256dh || !auth) return fail(400, 'Es fehlen die Schlüssel des Geräts.');

  const schon = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subs').first();

  await env.DB.prepare(`
    INSERT INTO push_subs (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth
  `).bind(endpoint, p256dh, auth, Date.now()).run();

  // Mit dem ersten Gerät fängt die Zeitrechnung an. Ohne das käme sofort alles
  // nach, was schon im Briefkasten liegt – und beim erneuten Anmelden nach
  // einer Pause alles, was in der Zwischenzeit angekommen ist.
  if ((schon?.n ?? 0) === 0) await marke(env, Date.now());

  return json({ ok: true });
}

async function handlePushUnsubscribe(request, env) {
  if (!(await isElevated(request, env))) return fail(401, 'Nicht freigeschaltet.');

  let body;
  try { body = await request.json(); } catch { return fail(400, 'Ungültige Anfrage.'); }

  await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?')
    .bind(String(body?.endpoint ?? '')).run();
  return json({ ok: true });
}

// ── Benachrichtigen ─────────────────────────────────────────────────────────
//
// Läuft nicht beim Upload, sondern minütlich als Cron. Der Grund ist der
// Normalfall: wer fünf Fotos auf einmal schickt, soll einmal „5 Dateien
// angekommen“ lesen und nicht fünfmal klingeln. Der Preis ist bis zu eine
// Minute Verzögerung – für einen Briefkasten belanglos.

async function marke(env, wert) {
  await env.DB.prepare(
    "INSERT INTO push_state (key, value) VALUES ('last_push', ?) "
    + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).bind(String(wert)).run();
}

// Baut die Meldung. Getrennt vom Versand, damit sie sich prüfen lässt.
export function meldung(dateien, texte) {
  const teile = [];
  if (dateien.length) teile.push(dateien.length === 1 ? 'eine Datei' : `${dateien.length} Dateien`);
  if (texte)          teile.push(texte === 1 ? 'ein Text' : `${texte} Texte`);

  const satz = teile.join(' und ');
  return {
    titel: satz.charAt(0).toUpperCase() + satz.slice(1) + ' angekommen',
    // Der Name der neuesten Datei als Vorschau. Er ist Ende-zu-Ende
    // verschlüsselt – der Push-Dienst sieht ihn nicht.
    text: dateien[0] ?? 'Texte & Links stehen auf der Abhol-Seite.',
  };
}

async function benachrichtigen(env) {
  if (!pushEingerichtet(env)) return 0;

  // Ohne Empfänger endet der Lauf nach einer Abfrage – ohne Schreibzugriff.
  // Das ist der Normalfall, 1440-mal am Tag.
  const abos = (await env.DB.prepare('SELECT endpoint, p256dh, auth FROM push_subs').all()).results ?? [];
  if (!abos.length) return 0;

  const seit = Number((await env.DB.prepare("SELECT value FROM push_state WHERE key = 'last_push'").first())?.value ?? 0);
  const jetzt = Date.now();
  if (!seit) {
    await marke(env, jetzt);
    return 0;
  }

  const [dateien, texte] = await env.DB.batch([
    env.DB.prepare('SELECT file_name FROM uploads WHERE completed_at > ? ORDER BY completed_at DESC LIMIT 50')
      .bind(seit),
    env.DB.prepare('SELECT COUNT(*) AS n FROM notes WHERE created_at > ?').bind(seit),
  ]);

  const namen   = (dateien.results ?? []).map(r => r.file_name);
  const anzahlT = texte.results?.[0]?.n ?? 0;
  if (!namen.length && !anzahlT) return 0;

  const nutzlast = JSON.stringify(meldung(namen, anzahlT));

  let zugestellt = 0;
  for (const abo of abos) {
    try {
      const res = await senden(abo, nutzlast, env);
      if (res.status === 404 || res.status === 410) {
        // Das Gerät hat das Abo weggeworfen. Nachfassen bringt nichts mehr.
        await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(abo.endpoint).run();
      } else if (res.ok) {
        zugestellt++;
      } else {
        console.error('Push abgelehnt:', res.status, await res.text());
      }
    } catch (err) {
      console.error('Push fehlgeschlagen:', err?.message || err);
    }
  }

  // Die Marke wandert auch dann weiter, wenn nichts zugestellt werden konnte:
  // sonst stünde beim nächsten Lauf dieselbe Meldung noch einmal an.
  await marke(env, jetzt);
  return zugestellt;
}

// ── Nächtlicher Aufräumlauf ─────────────────────────────────────────────────
//
// R2 rechnet nach liegendem Speicher ab. Ohne das hier bliebe jede jemals
// geschickte Datei für immer liegen und würde ab dem 11. GB Geld kosten.

async function purgeOld(env) {
  const now = Date.now();
  const fileCutoff = now - LIMITS.fileRetentionDays * DAY_MS;

  const old = await env.DB
    .prepare('SELECT r2_key FROM uploads WHERE completed_at IS NOT NULL AND completed_at < ?')
    .bind(fileCutoff)
    .all();

  const keys = (old.results ?? []).map(r => r.r2_key);
  // R2 nimmt bis zu 1000 Schlüssel auf einmal.
  for (let i = 0; i < keys.length; i += 1000) {
    await env.BUCKET.delete(keys.slice(i, i + 1000));
  }

  await env.DB.batch([
    env.DB.prepare('DELETE FROM uploads WHERE completed_at IS NOT NULL AND completed_at < ?').bind(fileCutoff),
    env.DB.prepare('DELETE FROM notes WHERE created_at < ?').bind(now - LIMITS.noteRetentionDays * DAY_MS),
  ]);

  return keys.length;
}

// ── Von fremden Seiten aus ──────────────────────────────────────────────────

// Die Kachel auf veerka.mp öffnet einen kleinen Briefkasten gleich im Dialog,
// statt hierher zu schicken. Dafür muss der Browser die Antworten dieser
// Routen von dort aus lesen dürfen.
//
// Erlaubt wird damit nichts Neues: anonym einwerfen darf ohnehin jeder, der
// diese Seite aufruft, und jede Grenze prüft weiterhin der Worker. CORS regelt
// allein, von welcher Seite aus der Browser die Antwort auslesen darf.
const CORS_HERKUNFT = new Set(['https://veerka.mp', 'https://www.veerka.mp']);

// Bewusst nur der Weg zum Einwerfen. /api/unlock steht nicht dabei: ein
// Sitzungstoken für das 10-GB-Limit soll nur auf dieser Seite entstehen, nicht
// im Speicher einer anderen. Ebenso wenig steht Authorization unten in den
// erlaubten Kopfzeilen – ein vorhandenes Token nützt von fremd also nichts.
const CORS_ROUTEN = new Set([
  '/api/status', '/api/note',
  '/api/upload/init', '/api/upload/part', '/api/upload/complete', '/api/upload/abort',
]);

function corsKopf(request, path, env) {
  const herkunft = request.headers.get('Origin');
  if (!herkunft || !CORS_ROUTEN.has(path)) return null;

  // Beim lokalen Entwickeln liegt die einwerfende Seite auf einem
  // localhost-Port. Welcher, steht in .dev.vars – einer Datei, die es in
  // Produktion nicht gibt. Von allein erkennen ließe sich der Fall nicht:
  // wrangler dev setzt Host und request.url auf die erste Route, localhost
  // taucht dort nirgends auf.
  const erlaubt = CORS_HERKUNFT.has(herkunft)
    || (env.DEV_HERKUNFT && herkunft === env.DEV_HERKUNFT);
  if (!erlaubt) return null;

  return {
    'Access-Control-Allow-Origin': herkunft,
    // Ohne Vary könnte ein Zwischenspeicher die Antwort für die eine Herkunft
    // an eine andere ausliefern.
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

const mitCors = (antwort, kopf) => {
  if (kopf) for (const [name, wert] of Object.entries(kopf)) antwort.headers.set(name, wert);
  return antwort;
};

// ── Verteiler ───────────────────────────────────────────────────────────────

// Welche Route unter welchem Hostnamen überhaupt existiert. Die Trennung ist
// nicht nur Kosmetik: unter upload.veerka.mp gibt es schlicht keinen Weg, an
// abgelegte Dateien zu kommen – auch nicht mit gültigem Sitzungstoken.
const ROUTES_UPLOAD = new Set([
  '/api/status', '/api/unlock', '/api/logout', '/api/note',
  '/api/upload/init', '/api/upload/part', '/api/upload/complete', '/api/upload/abort',
]);

// /api/purge gibt es nur hier: unter der öffentlichen Adresse soll nichts
// löschen können, auch nicht mit gültigem Sitzungstoken.
const ROUTES_DOWNLOAD = new Set([
  '/api/status', '/api/unlock', '/api/logout',
  '/api/files', '/api/files/download', '/api/notes', '/api/purge',
  '/api/push/subscribe', '/api/push/unsubscribe',
]);

// Statische Dateien, die es unter beiden Adressen gibt.
const gemeinsam = path => path === '/style.css' || path.startsWith('/favicon');

// Zubehör der Abhol-App: Manifest, Symbole, Service Worker, QR-Code. Gehört nur
// unter die Abhol-Adresse – dort wird die App installiert, nicht auf der
// Upload-Seite. Der QR-Code zeigt ohnehin dorthin: wer schon auf upload.veerka.mp
// steht, braucht ihn nicht.
const abholZubehoer = path =>
  path === '/download.webmanifest' || path === '/sw.js' || path === '/qr.svg'
  || path.startsWith('/icons/');

async function verteilen(path, request, env, ctx, url) {
  const post = request.method === 'POST';
  const del  = request.method === 'DELETE';
  if (path === '/api/status'          && request.method === 'GET') return await handleStatus(request, env);
  if (path === '/api/unlock'          && post)                     return await handleUnlock(request, env);
  if (path === '/api/logout'          && post)                     return handleLogout(request);
  if (path === '/api/upload/init'     && post)                     return await handleInit(request, env, ctx);
  if (path === '/api/upload/part'     && request.method === 'PUT') return await handlePart(request, env, url);
  if (path === '/api/upload/complete' && post)                     return await handleComplete(request, env);
  if (path === '/api/upload/abort'    && post)                     return await handleAbort(request, env);
  if (path === '/api/files'           && request.method === 'GET') return await handleList(request, env);
  if (path === '/api/files'           && del)                      return await handleFileDelete(request, env, url);
  if (path === '/api/files/download'  && request.method === 'GET') return await handleDownload(request, env, url);
  if (path === '/api/purge'           && post)                     return await handlePurge(request, env);
  if (path === '/api/push/subscribe'  && post)                     return await handlePushSubscribe(request, env);
  if (path === '/api/push/unsubscribe'&& post)                     return await handlePushUnsubscribe(request, env);
  if (path === '/api/note'            && post)                     return await handleNote(request, env);
  if (path === '/api/notes'           && request.method === 'GET') return await handleNotesList(request, env);
  if (path === '/api/notes'           && del)                      return await handleNoteDelete(request, env, url);
  return fail(404, 'Unbekannte Route.');
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Bewusst der Host-Header und nicht url.hostname: in Produktion ist beides
    // dasselbe – Cloudflare baut request.url aus genau diesem Header und routet
    // die Anfrage danach überhaupt erst hierher. Im lokalen wrangler dev steht
    // in request.url dagegen immer „localhost“, womit sich die Trennung der
    // beiden Adressen gar nicht testen ließe.
    const host = (request.headers.get('Host') || url.hostname).split(':')[0];
    const isDownloadSite = host.split('.')[0] === 'download';

    // Statische Dateien. Weil beide Adressen auf denselben Worker zeigen,
    // muss hier entschieden werden, welche Seite die richtige ist.
    //
    // Achtung beim Ändern: Cloudflare beantwortet „/download.html“ mit einer
    // Weiterleitung auf „/download“. Intern wird deshalb der endungslose Pfad
    // angefragt, sonst bekäme der Browser ein 307 statt der Seite.
    if (!path.startsWith('/api/')) {
      if (isDownloadSite) {
        // Unter der Abhol-Adresse gibt es nur diese eine Seite. Jeder andere
        // Pfad landet ebenfalls dort, statt versehentlich die Upload-Seite zu
        // zeigen – ausgenommen die Dateien, die es wirklich gibt.
        const assetPath = gemeinsam(path) || abholZubehoer(path) ? path : '/download';
        return env.ASSETS.fetch(new Request(new URL(assetPath, url), request));
      }

      // Umgekehrt darf die Abhol-Seite unter der öffentlichen Adresse gar
      // nicht auftauchen, ihr Zubehör ebenso wenig.
      if (path === '/download' || path.startsWith('/download.') || abholZubehoer(path)) {
        return new Response('Nicht gefunden', { status: 404 });
      }
      return env.ASSETS.fetch(request);
    }

    const erlaubt = isDownloadSite ? ROUTES_DOWNLOAD : ROUTES_UPLOAD;
    if (!erlaubt.has(path)) return fail(404, 'Unbekannte Route.');

    // Fremde Herkunft? Dann erst die Vorabfrage des Browsers beantworten.
    const cors = corsKopf(request, path, env);
    if (request.method === 'OPTIONS') {
      return cors ? new Response(null, { status: 204, headers: cors })
                  : fail(405, 'Nicht erlaubt.');
    }

    try {
      return mitCors(await verteilen(path, request, env, ctx, url), cors);
    } catch (err) {
      console.error(path, err?.stack || err);
      // Auch der Fehler braucht die Kopfzeilen, sonst sieht die fremde Seite
      // statt „Serverfehler“ nur einen nichtssagenden CORS-Abbruch.
      return mitCors(fail(500, 'Serverfehler.'), cors);
    }
  },

  // Läuft nach dem Zeitplan aus wrangler.jsonc. Zwei Zeitpläne, zwei Aufgaben –
  // unterschieden am Ausdruck selbst, damit nicht der minütliche Lauf jede
  // Nacht zusätzlich aufräumt.
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      if (event.cron === CRON_AUFRAEUMEN) {
        const removed = await purgeOld(env);
        await cleanup(env);
        console.log(`Aufräumlauf: ${removed} Datei(en) gelöscht.`);
        return;
      }
      const zugestellt = await benachrichtigen(env);
      if (zugestellt) console.log(`Benachrichtigung an ${zugestellt} Gerät(e).`);
    })());
  },
};
