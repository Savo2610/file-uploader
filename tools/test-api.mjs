// End-to-End-Test gegen den lokal laufenden Worker.
//
//   npx wrangler dev --port 8788      (in einem zweiten Terminal)
//   node tools/test-api.mjs
//
// Prüft nicht nur den Normalfall, sondern vor allem, ob sich die Limits
// umgehen lassen, wenn der Browser lügt.

import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';

const BASE = process.env.BASE || 'http://localhost:8788';

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

const post = (path, body, token) => fetch(BASE + path, {
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
    const res = await fetch(`${BASE}/api/upload/part?upload=${encodeURIComponent(ticket)}&part=${i + 1}`, {
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
const overflow = await fetch(`${BASE}/api/upload/part?upload=${encodeURIComponent(lieTicket)}&part=1`, {
  method: 'PUT', body: Buffer.alloc(5 * 1024 * 1024),
});
check('mehr Daten als angemeldet abgelehnt', overflow.status === 400, 'HTTP ' + overflow.status);

const badPart = await fetch(`${BASE}/api/upload/part?upload=${encodeURIComponent(lieTicket)}&part=99`, {
  method: 'PUT', body: Buffer.alloc(10),
});
check('ungültige Teilnummer abgelehnt', badPart.status === 400, 'HTTP ' + badPart.status);

const unknown = await fetch(`${BASE}/api/upload/part?upload=voellig-erfunden&part=1`, {
  method: 'PUT', body: Buffer.alloc(10),
});
check('erfundenes Upload-Token abgelehnt', unknown.status === 404, 'HTTP ' + unknown.status);

await post('/api/upload/abort', { upload: lieTicket });

console.log('\nZwei-Faktor-Anmeldung');

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
const withForged = await fetch(BASE + '/api/files', { headers: { Authorization: 'Bearer ' + forged } });
check('gefälschtes Sitzungstoken abgelehnt', withForged.status === 401, 'HTTP ' + withForged.status);

const tampered = token.split('.')[0] + '.' + 'A'.repeat(43);
const withTampered = await fetch(BASE + '/api/files', { headers: { Authorization: 'Bearer ' + tampered } });
check('manipulierte Signatur abgelehnt', withTampered.status === 401, 'HTTP ' + withTampered.status);

console.log('\nMit Freischaltung');

const statusUp = await (await fetch(BASE + '/api/status', {
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

const listAnon = await fetch(BASE + '/api/files');
check('Liste ohne Freischaltung gesperrt', listAnon.status === 401, 'HTTP ' + listAnon.status);

const list = await (await fetch(BASE + '/api/files', {
  headers: { Authorization: 'Bearer ' + token },
})).json();
check('Liste enthält die Uploads', list.files?.length >= 3, JSON.stringify(list).slice(0, 120));

const first = list.files.find(f => f.name === 'klein.txt');
const dl = await fetch(BASE + '/api/files/download?key=' + encodeURIComponent(first.key), {
  headers: { Authorization: 'Bearer ' + token },
});
const dlBody = Buffer.from(await dl.arrayBuffer());
check('Download liefert exakt die Bytes zurück', dlBody.equals(small),
  `${dlBody.length} statt ${small.length}`);
check('Download erzwingt Speichern statt Anzeigen',
  dl.headers.get('content-disposition')?.startsWith('attachment') &&
  dl.headers.get('content-type') === 'application/octet-stream',
  dl.headers.get('content-type') + ' / ' + dl.headers.get('content-disposition'));

const dlAnon = await fetch(BASE + '/api/files/download?key=' + encodeURIComponent(first.key));
check('Download ohne Freischaltung gesperrt', dlAnon.status === 401, 'HTTP ' + dlAnon.status);

const dlGuess = await fetch(BASE + '/api/files/download?key=' + encodeURIComponent('../../etc/passwd'), {
  headers: { Authorization: 'Bearer ' + token },
});
check('geratener Schlüssel läuft ins Leere', dlGuess.status === 404, 'HTTP ' + dlGuess.status);

console.log('\nDateinamen');

const nasty = await upload(Buffer.from('x'), '../../<img src=x onerror=alert(1)>.txt');
check('Pfad- und HTML-Tricks im Namen überstehen den Upload', nasty.failedAt === null,
  JSON.stringify(nasty.body));

const listAfter = await (await fetch(BASE + '/api/files', {
  headers: { Authorization: 'Bearer ' + token },
})).json();
const stored = listAfter.files.find(f => f.name.includes('img src'));
check('gespeicherter Schlüssel enthält kein ..',
  Boolean(stored) && !stored.key.includes('..'), stored?.key);

console.log('\nTageskontingent');

const statusNow = await (await fetch(BASE + '/api/status')).json();
check('Kontingent zählt die Uploads mit',
  statusNow.filesRemainingToday < statusNow.filesPerDay,
  `noch ${statusNow.filesRemainingToday} von ${statusNow.filesPerDay}`);
check('freigeschaltete Uploads zählen nicht gegen das Kontingent',
  statusUp.filesRemainingToday === null, JSON.stringify(statusUp.filesRemainingToday));

console.log(`\n${passed} bestanden, ${failed} fehlgeschlagen\n`);
process.exit(failed ? 1 : 0);
