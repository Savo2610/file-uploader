import {
  randomToken, sha256Hex, verifyTotp, signSession, verifySession,
} from './crypto.js';

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

  // Fehlversuche bei der Freischaltung, bevor die IP für eine Stunde gesperrt
  // wird. Ohne das ließen sich 6 Stellen in überschaubarer Zeit durchprobieren.
  maxAuthFailuresPerHour: 10,
};

// Größe eines Teilstücks beim Hochladen. Jedes Teil geht als eigene Anfrage
// durch den Worker und wird dort komplett im Speicher gehalten – deshalb
// bewusst klein: bei drei parallelen Teilen sind das 30 MB von 128 MB, die
// einem Worker zur Verfügung stehen. 10 GB ergeben damit 1024 Teile, das
// R2-Maximum liegt bei 10.000.
const PART_SIZE = 10 * 1024 * 1024;

const DAY_MS  = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

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

// Liefert true, wenn die Anfrage ein gültiges Sitzungstoken mitbringt.
//
// Normalfall ist der Authorization-Header, den das Skript der Seite setzt.
// Das Cookie wird nur dort akzeptiert, wo es sein muss – beim Download, weil
// ein <a href> keinen Header mitschicken kann. Überall sonst bliebe es eine
// offene Flanke für CSRF: ein Cookie schickt der Browser auch dann mit, wenn
// eine fremde Seite die Anfrage auslöst.
async function isElevated(request, env, { allowCookie = false } = {}) {
  if (!env.SESSION_SECRET) return false;

  const header = request.headers.get('Authorization') || '';
  let token = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!token && allowCookie) {
    const cookie = request.headers.get('Cookie') || '';
    token = /(?:^|;\s*)session=([^;]+)/.exec(cookie)?.[1] ?? '';
  }

  if (!token) return false;
  return (await verifySession(env.SESSION_SECRET, token)) !== null;
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
  const elevated = await isElevated(request, env);
  const used = await env.DB
    .prepare('SELECT COUNT(*) AS n FROM uploads WHERE elevated = 0 AND created_at > ?')
    .bind(Date.now() - DAY_MS)
    .first();

  return json({
    elevated,
    maxFileBytes: elevated ? LIMITS.elevatedMaxFileBytes : LIMITS.anonMaxFileBytes,
    elevatedMaxFileBytes: LIMITS.elevatedMaxFileBytes,
    partSize: PART_SIZE,
    filesPerDay: LIMITS.anonMaxFilesPerDay,
    filesRemainingToday: elevated ? null : Math.max(0, LIMITS.anonMaxFilesPerDay - (used?.n ?? 0)),
    twoFactorConfigured: Boolean(env.TOTP_SECRET && env.SESSION_SECRET),
  });
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
  const used = `${match.counter}`;
  try {
    await env.DB
      .prepare('INSERT INTO totp_used (code, expires_at) VALUES (?, ?)')
      .bind(used, now + 2 * 60 * 1000)
      .run();
  } catch {
    await env.DB.prepare('INSERT INTO auth_attempts (ip, ok, at) VALUES (?, 0, ?)').bind(ip, now).run();
    return fail(401, 'Dieser Code wurde bereits benutzt. Bitte den nächsten abwarten.');
  }

  await env.DB.prepare('INSERT INTO auth_attempts (ip, ok, at) VALUES (?, 1, ?)').bind(ip, now).run();

  const token = await signSession(env.SESSION_SECRET, LIMITS.sessionTtlSeconds);
  const secure = new URL(request.url).protocol === 'https:' ? ' Secure;' : '';

  const response = json({
    token,
    expiresIn: LIMITS.sessionTtlSeconds,
    maxFileBytes: LIMITS.elevatedMaxFileBytes,
  });
  // Nur für die Download-Links gedacht, siehe isElevated().
  response.headers.append(
    'Set-Cookie',
    `session=${token}; Path=/api/files;${secure} HttpOnly; SameSite=Strict; Max-Age=${LIMITS.sessionTtlSeconds}`,
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

// ── Verteiler ───────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!path.startsWith('/api/')) {
      // Sollte nicht vorkommen – statische Dateien beantwortet Cloudflare
      // bereits vor dem Worker.
      return new Response('Nicht gefunden', { status: 404 });
    }

    const post = request.method === 'POST';
    try {
      if (path === '/api/status'          && request.method === 'GET') return await handleStatus(request, env);
      if (path === '/api/unlock'          && post)                     return await handleUnlock(request, env);
      if (path === '/api/upload/init'     && post)                     return await handleInit(request, env, ctx);
      if (path === '/api/upload/part'     && request.method === 'PUT') return await handlePart(request, env, url);
      if (path === '/api/upload/complete' && post)                     return await handleComplete(request, env);
      if (path === '/api/upload/abort'    && post)                     return await handleAbort(request, env);
      if (path === '/api/files'           && request.method === 'GET') return await handleList(request, env);
      if (path === '/api/files/download'  && request.method === 'GET') return await handleDownload(request, env, url);
      return fail(404, 'Unbekannte Route.');
    } catch (err) {
      console.error(path, err?.stack || err);
      return fail(500, 'Serverfehler.');
    }
  },
};
