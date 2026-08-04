// End-to-End-Test gegen den lokal laufenden Worker.
//
// Die beiden Adressen müssen einzeln laufen: `wrangler dev` setzt den
// Hostnamen fest auf die erste Route aus wrangler.jsonc, ein einzelner Server
// kann also immer nur eine der beiden Seiten sein. Beide teilen sich den
// lokalen Zustand in .wrangler/, sehen also dieselben Dateien.
//
//   npx wrangler dev --port 8788
//   npx wrangler dev --port 8789 --host download.veerka.mp
//   node tools/test-api.mjs
//
// Gegen die echte Seite:
//   UPLOAD_BASE=https://upload.veerka.mp \
//   DOWNLOAD_BASE=https://download.veerka.mp node tools/test-api.mjs
//
// Prüft nicht nur den Normalfall, sondern vor allem, ob sich die Limits
// umgehen lassen, wenn der Browser lügt.

import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';

const UP = process.env.UPLOAD_BASE   || 'http://localhost:8788';
const DL = process.env.DOWNLOAD_BASE || 'http://localhost:8789';

const vars = Object.fromEntries(
  readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8')
    .split('\n').filter(Boolean).map(l => l.split(/=(.*)/s).slice(0, 2)),
);

// ── TOTP-Code erzeugen (Gegenstück zur Prüfung im Worker) ───────────────────

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(s) {
  let bits = 0, value = 0; const out = [];
  for (const ch of s.toUpperCase().replace(/[=\s-]/g, '')) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

function totp(secret, offsetSteps = 0) {
  const counter = Math.floor(Date.now() / 1000 / 30) + offsetSteps;
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const sig = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const off = sig[sig.length - 1] & 0x0f;
  const bin = ((sig[off] & 0x7f) << 24) | (sig[off + 1] << 16) | (sig[off + 2] << 8) | sig[off + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

// ── Testgerüst ──────────────────────────────────────────────────────────────

let passed = 0, failed = 0;

function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else    { failed++; console.log(`  ✗ ${name}${detail ? '  → ' + detail : ''}`); }
}

const post = (path, body, token, base = UP) => fetch(base + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
  body: JSON.stringify(body),
});

// Lädt einen Puffer komplett hoch und gibt die Antwort von /complete zurück.
async function upload(buf, fileName, token) {
  const init = await post('/api/upload/init', {
    fileName, size: buf.length, contentType: 'application/octet-stream',
  }, token);
  if (!init.ok) return { failedAt: 'init', status: init.status, body: await init.json() };

  const { upload: ticket, partSize, partCount } = await init.json();
  const parts = [];
  for (let i = 0; i < partCount; i++) {
    const slice = buf.subarray(i * partSize, Math.min((i + 1) * partSize, buf.length));
    const res = await fetch(`${UP}/api/upload/part?upload=${encodeURIComponent(ticket)}&part=${i + 1}`, {
      method: 'PUT', body: slice,
    });
    if (!res.ok) return { failedAt: 'part' + (i + 1), status: res.status, body: await res.json() };
    parts.push(await res.json());
  }

  const done = await post('/api/upload/complete', { upload: ticket, parts }, token);
  return { failedAt: done.ok ? null : 'complete', status: done.status, body: await done.json(), ticket };
}

// ── Los ─────────────────────────────────────────────────────────────────────

console.log('\nGrundfunktionen');

const small = Buffer.from('Hallo, das ist eine kleine Testdatei.\n'.repeat(10));
const r1 = await upload(small, 'klein.txt');
check('kleine Datei ohne Freischaltung', r1.failedAt === null, JSON.stringify(r1.body));

// 25 MB → 3 Teilstücke à 10 MB
const big = Buffer.alloc(25 * 1024 * 1024, 7);
const r2 = await upload(big, 'mittel.bin');
check('25 MB über drei Teilstücke', r2.failedAt === null, JSON.stringify(r2.body));

const r3 = await upload(Buffer.alloc(0), 'leer.txt');
check('leere Datei', r3.failedAt === null, JSON.stringify(r3.body));

console.log('\nLimits – der Browser darf nicht entscheiden');

const initTooBig = await post('/api/upload/init', {
  fileName: 'zu-gross.bin', size: 60 * 1024 * 1024, contentType: 'application/octet-stream',
});
check('60 MB ohne Freischaltung abgelehnt', initTooBig.status === 413,
  'HTTP ' + initTooBig.status);

// Kleine Größe anmelden, dann mehr Daten nachschieben.
const lie = await post('/api/upload/init', {
  fileName: 'luegner.bin', size: 1024, contentType: 'application/octet-stream',
});
const { upload: lieTicket } = await lie.json();
const overflow = await fetch(`${UP}/api/upload/part?upload=${encodeURIComponent(lieTicket)}&part=1`, {
  method: 'PUT', body: Buffer.alloc(5 * 1024 * 1024),
});
check('mehr Daten als angemeldet abgelehnt', overflow.status === 400, 'HTTP ' + overflow.status);

const badPart = await fetch(`${UP}/api/upload/part?upload=${encodeURIComponent(lieTicket)}&part=99`, {
  method: 'PUT', body: Buffer.alloc(10),
});
check('ungültige Teilnummer abgelehnt', badPart.status === 400, 'HTTP ' + badPart.status);

const unknown = await fetch(`${UP}/api/upload/part?upload=voellig-erfunden&part=1`, {
  method: 'PUT', body: Buffer.alloc(10),
});
check('erfundenes Upload-Token abgelehnt', unknown.status === 404, 'HTTP ' + unknown.status);

await post('/api/upload/abort', { upload: lieTicket });

console.log('\nZwei-Faktor-Anmeldung');

// Jeder Lauf produziert absichtlich Fehlversuche. Nach zehn davon in einer
// Stunde sperrt der Worker die IP – zu Recht, aber dann testet sich der Rest
// nicht mehr. Lokal wird das Protokoll deshalb vorher geleert; an der echten
// Seite bleibt es unangetastet.
if (UP.includes('localhost')) {
  const { execFileSync } = await import('node:child_process');
  execFileSync('npx', [
    'wrangler', 'd1', 'execute', 'upload-meta', '--local',
    '--command', 'DELETE FROM auth_attempts',
  ], { cwd: new URL('..', import.meta.url).pathname, stdio: 'ignore' });
}

const wrong = await post('/api/unlock', { code: '000000' });
check('falscher Code abgelehnt', wrong.status === 401, 'HTTP ' + wrong.status);

const noCode = await post('/api/unlock', { code: 'abcdef' });
check('unsinniger Code abgelehnt', noCode.status === 401, 'HTTP ' + noCode.status);

const code = totp(vars.TOTP_SECRET);
const ok = await post('/api/unlock', { code });
const okBody = await ok.json();
check('richtiger Code akzeptiert', ok.status === 200 && Boolean(okBody.token), JSON.stringify(okBody));
const token = okBody.token;

const replay = await post('/api/unlock', { code });
check('derselbe Code ein zweites Mal abgelehnt', replay.status === 401,
  'HTTP ' + replay.status);

const forged = 'abc.def';
const withForged = await fetch(DL + '/api/files', { headers: { Authorization: 'Bearer ' + forged } });
check('gefälschtes Sitzungstoken abgelehnt', withForged.status === 401, 'HTTP ' + withForged.status);

const tampered = token.split('.')[0] + '.' + 'A'.repeat(43);
const withTampered = await fetch(DL + '/api/files', { headers: { Authorization: 'Bearer ' + tampered } });
check('manipulierte Signatur abgelehnt', withTampered.status === 401, 'HTTP ' + withTampered.status);

console.log('\nMit Freischaltung');

const statusUp = await (await fetch(UP + '/api/status', {
  headers: { Authorization: 'Bearer ' + token },
})).json();
check('Status meldet 10 GB', statusUp.elevated && statusUp.maxFileBytes === 10 * 1024 ** 3,
  JSON.stringify(statusUp));

const initHuge = await post('/api/upload/init', {
  fileName: 'riesig.bin', size: 8 * 1024 ** 3, contentType: 'application/octet-stream',
}, token);
check('8 GB mit Freischaltung angenommen', initHuge.status === 200, 'HTTP ' + initHuge.status);
if (initHuge.status === 200) await post('/api/upload/abort', { upload: (await initHuge.json()).upload });

const initTooHuge = await post('/api/upload/init', {
  fileName: 'zu-riesig.bin', size: 11 * 1024 ** 3, contentType: 'application/octet-stream',
}, token);
check('11 GB auch mit Freischaltung abgelehnt', initTooHuge.status === 413, 'HTTP ' + initTooHuge.status);

console.log('\nDateien ansehen und holen');

const listAnon = await fetch(DL + '/api/files');
check('Liste ohne Freischaltung gesperrt', listAnon.status === 401, 'HTTP ' + listAnon.status);

const list = await (await fetch(DL + '/api/files', {
  headers: { Authorization: 'Bearer ' + token },
})).json();
check('Liste enthält die Uploads', list.files?.length >= 3, JSON.stringify(list).slice(0, 120));

const first = list.files.find(f => f.name === 'klein.txt');
const dl = await fetch(DL + '/api/files/download?key=' + encodeURIComponent(first.key), {
  headers: { Authorization: 'Bearer ' + token },
});
const dlBody = Buffer.from(await dl.arrayBuffer());
check('Download liefert exakt die Bytes zurück', dlBody.equals(small),
  `${dlBody.length} statt ${small.length}`);
check('Download erzwingt Speichern statt Anzeigen',
  dl.headers.get('content-disposition')?.startsWith('attachment') &&
  dl.headers.get('content-type') === 'application/octet-stream',
  dl.headers.get('content-type') + ' / ' + dl.headers.get('content-disposition'));

const dlAnon = await fetch(DL + '/api/files/download?key=' + encodeURIComponent(first.key));
check('Download ohne Freischaltung gesperrt', dlAnon.status === 401, 'HTTP ' + dlAnon.status);

const dlGuess = await fetch(DL + '/api/files/download?key=' + encodeURIComponent('../../etc/passwd'), {
  headers: { Authorization: 'Bearer ' + token },
});
check('geratener Schlüssel läuft ins Leere', dlGuess.status === 404, 'HTTP ' + dlGuess.status);

console.log('\nDateinamen');

const nasty = await upload(Buffer.from('x'), '../../<img src=x onerror=alert(1)>.txt');
check('Pfad- und HTML-Tricks im Namen überstehen den Upload', nasty.failedAt === null,
  JSON.stringify(nasty.body));

const listAfter = await (await fetch(DL + '/api/files', {
  headers: { Authorization: 'Bearer ' + token },
})).json();
const stored = listAfter.files.find(f => f.name.includes('img src'));
check('gespeicherter Schlüssel enthält kein ..',
  Boolean(stored) && !stored.key.includes('..'), stored?.key);

console.log('\nText und Links');

const noteRes = await post('/api/note', { text: 'Schau mal: https://example.com/foo?a=1\nUnd noch eine Zeile.' });
check('Text ohne Freischaltung annehmbar', noteRes.status === 200, 'HTTP ' + noteRes.status);

const emptyNote = await post('/api/note', { text: '   ' });
check('leerer Text abgelehnt', emptyNote.status === 400, 'HTTP ' + emptyNote.status);

const longNote = await post('/api/note', { text: 'x'.repeat(25_000) });
check('zu langer Text abgelehnt', longNote.status === 413, 'HTTP ' + longNote.status);

const notesAnon = await fetch(DL + '/api/notes');
check('Textliste ohne Freischaltung gesperrt', notesAnon.status === 401, 'HTTP ' + notesAnon.status);

const notes = await (await fetch(DL + '/api/notes', {
  headers: { Authorization: 'Bearer ' + token },
})).json();
check('Text kommt unverändert zurück',
  notes.notes?.[0]?.text.includes('https://example.com/foo?a=1'),
  JSON.stringify(notes.notes?.[0]).slice(0, 100));

console.log('\nLöschen');

const delAnon = await fetch(DL + '/api/notes?id=' + encodeURIComponent(notes.notes[0].id), { method: 'DELETE' });
check('Text löschen ohne Freischaltung gesperrt', delAnon.status === 401, 'HTTP ' + delAnon.status);

const delNote = await fetch(DL + '/api/notes?id=' + encodeURIComponent(notes.notes[0].id), {
  method: 'DELETE', headers: { Authorization: 'Bearer ' + token },
});
const notesAfter = await (await fetch(DL + '/api/notes', {
  headers: { Authorization: 'Bearer ' + token },
})).json();
check('Text ist danach weg',
  delNote.status === 200 && !notesAfter.notes.some(n => n.id === notes.notes[0].id));

const victim = (await (await fetch(DL + '/api/files', {
  headers: { Authorization: 'Bearer ' + token },
})).json()).files.find(f => f.name === 'mittel.bin');

const delFileAnon = await fetch(DL + '/api/files?key=' + encodeURIComponent(victim.key), { method: 'DELETE' });
check('Datei löschen ohne Freischaltung gesperrt', delFileAnon.status === 401, 'HTTP ' + delFileAnon.status);

const delFile = await fetch(DL + '/api/files?key=' + encodeURIComponent(victim.key), {
  method: 'DELETE', headers: { Authorization: 'Bearer ' + token },
});
const gone = await fetch(DL + '/api/files/download?key=' + encodeURIComponent(victim.key), {
  headers: { Authorization: 'Bearer ' + token },
});
check('Datei ist danach auch aus R2 weg', delFile.status === 200 && gone.status === 404,
  `löschen ${delFile.status}, danach ${gone.status}`);

console.log('\nTrennung der beiden Adressen');

// Der Kern der Trennung: unter der öffentlichen Adresse gibt es keinen Weg an
// abgelegte Dateien – auch nicht mit einem gültigen Sitzungstoken.
const filesOnUpload = await fetch(UP + '/api/files', { headers: { Authorization: 'Bearer ' + token } });
check('Dateiliste auf der Upload-Seite nicht vorhanden', filesOnUpload.status === 404,
  'HTTP ' + filesOnUpload.status);

const dlOnUpload = await fetch(UP + '/api/files/download?key=egal', {
  headers: { Authorization: 'Bearer ' + token },
});
check('Download auf der Upload-Seite nicht vorhanden', dlOnUpload.status === 404, 'HTTP ' + dlOnUpload.status);

const notesOnUpload = await fetch(UP + '/api/notes', { headers: { Authorization: 'Bearer ' + token } });
check('Textliste auf der Upload-Seite nicht vorhanden', notesOnUpload.status === 404, 'HTTP ' + notesOnUpload.status);

const initOnDownload = await post('/api/upload/init', {
  fileName: 'x.txt', size: 10, contentType: 'text/plain',
}, token, DL);
check('Hochladen auf der Abhol-Seite nicht vorhanden', initOnDownload.status === 404,
  'HTTP ' + initOnDownload.status);

const noteOnDownload = await post('/api/note', { text: 'test' }, null, DL);
check('Text einwerfen auf der Abhol-Seite nicht vorhanden', noteOnDownload.status === 404,
  'HTTP ' + noteOnDownload.status);

const seiteUpload = await (await fetch(UP + '/')).text();
check('Upload-Adresse liefert die Upload-Seite',
  seiteUpload.includes('id="dropzone"') && !seiteUpload.includes('id="files-list"'));

const seiteDownload = await (await fetch(DL + '/')).text();
check('Abhol-Adresse liefert die Abhol-Seite',
  seiteDownload.includes('id="files-list"') && !seiteDownload.includes('id="dropzone"'));

const versteckt = await fetch(UP + '/download.html');
check('Abhol-Seite nicht über die Upload-Adresse erreichbar', versteckt.status === 404,
  'HTTP ' + versteckt.status);

console.log('\nTageskontingent');

const statusNow = await (await fetch(UP + '/api/status')).json();
check('Kontingent zählt die Uploads mit',
  statusNow.filesRemainingToday < statusNow.filesPerDay,
  `noch ${statusNow.filesRemainingToday} von ${statusNow.filesPerDay}`);
check('freigeschaltete Uploads zählen nicht gegen das Kontingent',
  statusUp.filesRemainingToday === null, JSON.stringify(statusUp.filesRemainingToday));

console.log(`\n${passed} bestanden, ${failed} fehlgeschlagen\n`);
process.exit(failed ? 1 : 0);
