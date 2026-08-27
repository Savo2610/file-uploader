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

// Jeder Dateiname aus diesem Lauf trägt dieses Präfix. tools/cleanup-tests.mjs
// löscht ausschließlich Dateien, die so heißen – damit ein Aufräumen niemals
// echte Uploads erwischt.
export const TEST_PREFIX = 'TESTLAUF-';

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
    fileName: TEST_PREFIX + fileName, size: buf.length, contentType: 'application/octet-stream',
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
  fileName: TEST_PREFIX + 'zu-gross.bin', size: 60 * 1024 * 1024, contentType: 'application/octet-stream',
});
check('60 MB ohne Freischaltung abgelehnt', initTooBig.status === 413,
  'HTTP ' + initTooBig.status);

// Kleine Größe anmelden, dann mehr Daten nachschieben.
const lie = await post('/api/upload/init', {
  fileName: TEST_PREFIX + 'luegner.bin', size: 1024, contentType: 'application/octet-stream',
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
// nicht mehr. Dasselbe gilt für die verbrauchten Codes: ein Lauf braucht zwei
// Zeitfenster, ein zweiter Lauf kurz danach fände nur noch benutzte vor.
// Lokal werden beide Protokolle deshalb vorher geleert; an der echten Seite
// bleiben sie unangetastet.
if (UP.includes('localhost')) {
  const { execFileSync } = await import('node:child_process');
  execFileSync('npx', [
    'wrangler', 'd1', 'execute', 'upload-meta', '--local',
    '--command', 'DELETE FROM auth_attempts; DELETE FROM totp_used',
  ], { cwd: new URL('..', import.meta.url).pathname, stdio: 'ignore' });
}

const wrong = await post('/api/unlock', { code: '000000' });
check('falscher Code abgelehnt', wrong.status === 401, 'HTTP ' + wrong.status);

const noCode = await post('/api/unlock', { code: 'abcdef' });
check('unsinniger Code abgelehnt', noCode.status === 401, 'HTTP ' + noCode.status);

// Ein Code gilt genau einmal. Ein Testlauf braucht zwei davon, und ein Lauf
// kurz nach dem vorigen träfe sonst auf lauter schon verbrauchte Zeitfenster –
// deshalb der Reihe nach das aktuelle und seine beiden Nachbarn, die alle in
// der erlaubten Abweichung liegen.
async function freischalten(extra = {}, base = UP) {
  let res, body;
  for (const fenster of [0, 1, -1]) {
    const code = totp(vars.TOTP_SECRET, fenster);
    res  = await post('/api/unlock', { code, ...extra }, null, base);
    body = await res.json();
    if (res.ok) return { res, body, code };
  }
  return { res, body, code: null };
}

const { res: ok, body: okBody, code } = await freischalten();
check('richtiger Code akzeptiert', ok.status === 200 && Boolean(okBody.token), JSON.stringify(okBody));
const token = okBody.token;

check('ohne „angemeldet bleiben“ gilt die Sitzung 6 Stunden',
  okBody.expiresIn === 6 * 60 * 60, String(okBody.expiresIn));

const replay = await post('/api/unlock', { code });
check('derselbe Code ein zweites Mal abgelehnt', replay.status === 401,
  'HTTP ' + replay.status);

const { res: lang, body: langBody } = await freischalten({ remember: true }, DL);
const DREISSIG_TAGE = 30 * 24 * 60 * 60;

check('„angemeldet bleiben“ gibt eine Sitzung über 30 Tage',
  lang.status === 200 && langBody.expiresIn === DREISSIG_TAGE, JSON.stringify(langBody));
check('das Cookie für die Download-Links hält genauso lange',
  (lang.headers.get('set-cookie') || '').includes('Max-Age=' + DREISSIG_TAGE),
  lang.headers.get('set-cookie'));

const langToken = langBody.token;

const langStatus = await (await fetch(DL + '/api/status', {
  headers: { Authorization: 'Bearer ' + langToken },
})).json();
check('lange Sitzung läuft erst in ungefähr 30 Tagen ab',
  langStatus.sessionExpiresAt - Date.now() > 29 * 24 * 60 * 60 * 1000,
  String(langStatus.sessionExpiresAt));
check('ein frisches Token wird noch nicht verlängert', langStatus.token === undefined,
  JSON.stringify(langStatus.token));

// Ein Token bauen, das gleich abläuft – anders ließe sich die gleitende
// Verlängerung nicht prüfen, ohne zwei Wochen zu warten.
function sitzung(ttl, restSekunden) {
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + restSekunden, ttl, jti: 'testlauf',
  })).toString('base64url');
  const sig = createHmac('sha256', vars.SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

const fastAb = sitzung(DREISSIG_TAGE, 60 * 60);
const verlaengert = await (await fetch(DL + '/api/status', {
  headers: { Authorization: 'Bearer ' + fastAb },
})).json();
check('eine halb abgelaufene Sitzung bekommt ein frisches Token',
  Boolean(verlaengert.token) && verlaengert.token !== fastAb,
  JSON.stringify(verlaengert.token));
check('das frische Token gilt wieder von vorn',
  verlaengert.sessionExpiresAt !== undefined && verlaengert.expiresIn === DREISSIG_TAGE,
  String(verlaengert.expiresIn));

const mitVerlaengertem = await fetch(DL + '/api/files', {
  headers: { Authorization: 'Bearer ' + verlaengert.token },
});
check('mit dem frischen Token geht es weiter', mitVerlaengertem.status === 200,
  'HTTP ' + mitVerlaengertem.status);

const laengstAb = sitzung(DREISSIG_TAGE, -60);
const totesToken = await fetch(DL + '/api/status', {
  headers: { Authorization: 'Bearer ' + laengstAb },
});
const totBody = await totesToken.json();
check('ein abgelaufenes Token wird nicht verlängert',
  totBody.elevated === false && totBody.token === undefined, JSON.stringify(totBody.token));

const abgemeldet = await fetch(DL + '/api/logout', { method: 'POST' });
check('Abmelden löscht das Cookie',
  abgemeldet.status === 200 && (abgemeldet.headers.get('set-cookie') || '').includes('Max-Age=0'),
  abgemeldet.headers.get('set-cookie'));

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
  fileName: TEST_PREFIX + 'riesig.bin', size: 8 * 1024 ** 3, contentType: 'application/octet-stream',
}, token);
check('8 GB mit Freischaltung angenommen', initHuge.status === 200, 'HTTP ' + initHuge.status);
if (initHuge.status === 200) await post('/api/upload/abort', { upload: (await initHuge.json()).upload });

const initTooHuge = await post('/api/upload/init', {
  fileName: TEST_PREFIX + 'zu-riesig.bin', size: 11 * 1024 ** 3, contentType: 'application/octet-stream',
}, token);
check('11 GB auch mit Freischaltung abgelehnt', initTooHuge.status === 413, 'HTTP ' + initTooHuge.status);

console.log('\nDateien ansehen und holen');

const listAnon = await fetch(DL + '/api/files');
check('Liste ohne Freischaltung gesperrt', listAnon.status === 401, 'HTTP ' + listAnon.status);

const list = await (await fetch(DL + '/api/files', {
  headers: { Authorization: 'Bearer ' + token },
})).json();
check('Liste enthält die Uploads', list.files?.length >= 3, JSON.stringify(list).slice(0, 120));

const first = list.files.find(f => f.name === TEST_PREFIX + 'klein.txt');
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
})).json()).files.find(f => f.name === TEST_PREFIX + 'mittel.bin');

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

console.log('\nAlles auf einmal löschen');

// Nur Dateien aus diesem Lauf. Läuft der Test gegen die echte Seite, darf er
// unter keinen Umständen etwas anderes anfassen.
const meins = (await (await fetch(DL + '/api/files', {
  headers: { Authorization: 'Bearer ' + token },
})).json()).files.filter(f => f.name.startsWith(TEST_PREFIX));

const purgeAnon = await post('/api/purge', { keys: [meins[0].key] }, null, DL);
check('Sammellöschen ohne Freischaltung gesperrt', purgeAnon.status === 401, 'HTTP ' + purgeAnon.status);

const purgeOhne = await post('/api/purge', {}, token, DL);
check('Sammellöschen ohne Angabe abgelehnt', purgeOhne.status === 400, 'HTTP ' + purgeOhne.status);

const purgeErfunden = await post('/api/purge', { keys: ['gibt/es/nicht'] }, token, DL);
const erfundenBody = await purgeErfunden.json();
check('erfundener Schlüssel löscht nichts',
  purgeErfunden.status === 200 && erfundenBody.files === 0, JSON.stringify(erfundenBody));

// Ein Text und zwei Dateien: alles, was der Knopf auf der Seite auch schickt.
await post('/api/note', { text: TEST_PREFIX + 'wird gleich gelöscht' });
const zuLoeschenTexte = (await (await fetch(DL + '/api/notes', {
  headers: { Authorization: 'Bearer ' + token },
})).json()).notes.filter(n => n.text.startsWith(TEST_PREFIX));

const opfer = meins.slice(0, 2).map(f => f.key);
const purge = await post('/api/purge', {
  keys: opfer, noteIds: zuLoeschenTexte.map(n => n.id),
}, token, DL);
const purgeBody = await purge.json();
check('Sammellöschen nimmt Dateien und Texte',
  purge.status === 200 && purgeBody.files === opfer.length && purgeBody.notes === zuLoeschenTexte.length,
  JSON.stringify(purgeBody));

const nachher = await (await fetch(DL + '/api/files', {
  headers: { Authorization: 'Bearer ' + token },
})).json();
check('die gelöschten Dateien stehen nicht mehr in der Liste',
  !nachher.files.some(f => opfer.includes(f.key)));

const wegAusR2 = await fetch(DL + '/api/files/download?key=' + encodeURIComponent(opfer[0]), {
  headers: { Authorization: 'Bearer ' + token },
});
check('sie sind auch aus R2 weg', wegAusR2.status === 404, 'HTTP ' + wegAusR2.status);

// Der Kern der Sache: es wird genau das gelöscht, was mitgeschickt wurde.
// Was zwischen Herunterladen und Löschen ankommt, muss liegen bleiben.
const ueberlebt = nachher.files.filter(f => f.name.startsWith(TEST_PREFIX));
check('nicht mitgeschickte Dateien bleiben liegen', ueberlebt.length > 0,
  `${ueberlebt.length} übrig`);

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
  fileName: TEST_PREFIX + 'x.txt', size: 10, contentType: 'text/plain',
}, token, DL);
check('Hochladen auf der Abhol-Seite nicht vorhanden', initOnDownload.status === 404,
  'HTTP ' + initOnDownload.status);

const noteOnDownload = await post('/api/note', { text: 'test' }, null, DL);
check('Text einwerfen auf der Abhol-Seite nicht vorhanden', noteOnDownload.status === 404,
  'HTTP ' + noteOnDownload.status);

const purgeOnUpload = await post('/api/purge', { keys: ['egal'] }, token, UP);
check('Sammellöschen auf der Upload-Seite nicht vorhanden', purgeOnUpload.status === 404,
  'HTTP ' + purgeOnUpload.status);

const seiteUpload = await (await fetch(UP + '/')).text();
check('Upload-Adresse liefert die Upload-Seite',
  seiteUpload.includes('id="dropzone"') && !seiteUpload.includes('id="files-list"'));

const seiteDownload = await (await fetch(DL + '/')).text();
check('Abhol-Adresse liefert die Abhol-Seite',
  seiteDownload.includes('id="files-list"') && !seiteDownload.includes('id="dropzone"'));

const versteckt = await fetch(UP + '/download.html');
check('Abhol-Seite nicht über die Upload-Adresse erreichbar', versteckt.status === 404,
  'HTTP ' + versteckt.status);

console.log('\nApp auf dem Startbildschirm');

// Ohne diese drei Dateien legt Android nur eine Verknüpfung mit Chrome-Logo
// an statt einer App mit eigenem Symbol.
const manifestRes = await fetch(DL + '/download.webmanifest');
const manifest = manifestRes.ok ? await manifestRes.json() : null;
check('Manifest wird ausgeliefert', manifestRes.status === 200, 'HTTP ' + manifestRes.status);
check('Manifest bringt 192er und 512er Symbole mit',
  ['192x192', '512x512'].every(s => manifest?.icons?.some(i => i.sizes === s)),
  JSON.stringify(manifest?.icons?.map(i => i.sizes)));
check('Manifest enthält ein maskable Symbol',
  manifest?.icons?.some(i => i.purpose === 'maskable'));

const iconRes = await fetch(DL + '/icons/abholen-512.png');
const iconBuf = Buffer.from(await iconRes.arrayBuffer());
check('Symbol ist ein echtes PNG',
  iconRes.status === 200 && iconBuf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  'HTTP ' + iconRes.status);

const swRes = await fetch(DL + '/sw.js');
const swText = swRes.ok ? await swRes.text() : '';
check('Service Worker wird ausgeliefert', swRes.status === 200, 'HTTP ' + swRes.status);
check('Service Worker fasst /api/ nicht an', swText.includes("startsWith('/api/')"));

const seiteMitManifest = await (await fetch(DL + '/')).text();
check('Abhol-Seite verweist auf das Manifest', seiteMitManifest.includes('rel="manifest"'));

// Das Zubehör gehört zur Abhol-Adresse und hat unter der öffentlichen nichts
// zu suchen – sonst ließe sich von dort auf die Existenz der anderen schließen.
for (const pfad of ['/download.webmanifest', '/sw.js', '/icons/abholen-512.png']) {
  const res = await fetch(UP + pfad);
  check(`${pfad} auf der Upload-Adresse nicht vorhanden`, res.status === 404, 'HTTP ' + res.status);
}

console.log('\nBenachrichtigungen');

const pushAnon = await post('/api/push/subscribe',
  { endpoint: 'https://example.com/x', p256dh: 'a', auth: 'b' }, null, DL);
check('Anmelden ohne Freischaltung gesperrt', pushAnon.status === 401, 'HTTP ' + pushAnon.status);

const pushHttp = await post('/api/push/subscribe',
  { endpoint: 'http://example.com/x', p256dh: 'a', auth: 'b' }, token, DL);
check('Adresse ohne https abgelehnt', pushHttp.status === 400, 'HTTP ' + pushHttp.status);

const pushKrumm = await post('/api/push/subscribe',
  { endpoint: 'keine-adresse', p256dh: 'a', auth: 'b' }, token, DL);
check('unbrauchbare Adresse abgelehnt', pushKrumm.status === 400, 'HTTP ' + pushKrumm.status);

const pushOhneSchluessel = await post('/api/push/subscribe',
  { endpoint: 'https://example.com/x' }, token, DL);
check('Anmeldung ohne Geräteschlüssel abgelehnt', pushOhneSchluessel.status === 400,
  'HTTP ' + pushOhneSchluessel.status);

// Ein echtes Abo nachbauen, wie es der Browser schicken würde.
const geraet = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const geraetPub = new Uint8Array(await crypto.subtle.exportKey('raw', geraet.publicKey));
const geraetAuth = crypto.getRandomValues(new Uint8Array(16));
const abo = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/TESTLAUF-' + Date.now(),
  p256dh: Buffer.from(geraetPub).toString('base64url'),
  auth:   Buffer.from(geraetAuth).toString('base64url'),
};

const pushAn = await post('/api/push/subscribe', abo, token, DL);
check('Anmelden mit Freischaltung angenommen', pushAn.status === 200, 'HTTP ' + pushAn.status);

const pushNochmal = await post('/api/push/subscribe', abo, token, DL);
check('zweimal dasselbe Gerät bleibt ein Eintrag', pushNochmal.status === 200,
  'HTTP ' + pushNochmal.status);

const statusPush = await (await fetch(DL + '/api/status')).json();
check('Status nennt den öffentlichen Schlüssel',
  typeof statusPush.pushPublicKey === 'string' && statusPush.pushPublicKey.length > 80,
  String(statusPush.pushPublicKey).slice(0, 20));

const pushAus = await post('/api/push/unsubscribe', { endpoint: abo.endpoint }, token, DL);
check('Abmelden angenommen', pushAus.status === 200, 'HTTP ' + pushAus.status);

const pushAufUpload = await post('/api/push/subscribe', abo, token, UP);
check('Anmelden auf der Upload-Seite nicht vorhanden', pushAufUpload.status === 404,
  'HTTP ' + pushAufUpload.status);

console.log('\nZustellung einer Benachrichtigung');

// Hier läuft ein eigener kleiner Push-Dienst mit, und geprüft wird genau das,
// was bei ihm ankommt. An Google lässt sich im Test nicht zustellen, aber die
// Nachricht muss trotzdem bis aufs Byte stimmen: ein falsches Feld, und das
// Handy verwirft sie stillschweigend.
const { senden, vapidSchluesselpaar } = await import('../src/push.js');
const { meldung } = await import('../src/index.js');
const { createServer } = await import('node:http');

let antwortStatus = 201;
let empfangen = null;
const dienst = createServer((req, res) => {
  const stuecke = [];
  req.on('data', c => stuecke.push(c));
  req.on('end', () => {
    empfangen = { methode: req.method, kopf: req.headers, koerper: Buffer.concat(stuecke) };
    res.writeHead(antwortStatus).end();
  });
});
await new Promise(r => dienst.listen(0, '127.0.0.1', r));
const dienstAdresse = `http://127.0.0.1:${dienst.address().port}/push/xyz`;

const paar = await vapidSchluesselpaar();
const testEnv = { VAPID_PUBLIC: paar.oeffentlich, VAPID_PRIVATE: paar.geheim };
const nutzlast = JSON.stringify(meldung(['Ümlaut & "Zeichen".txt', 'b', 'c'], 1));

const antwort = await senden({ ...abo, endpoint: dienstAdresse }, nutzlast, testEnv);
check('der Push-Dienst nimmt die Nachricht an', antwort.status === 201, 'HTTP ' + antwort.status);
check('sie geht als POST raus', empfangen?.methode === 'POST', empfangen?.methode);
check('Content-Encoding sagt aes128gcm', empfangen?.kopf['content-encoding'] === 'aes128gcm',
  empfangen?.kopf['content-encoding']);
check('ein TTL liegt bei', Number(empfangen?.kopf.ttl) > 0, empfangen?.kopf.ttl);

// ── Der Kopf: VAPID ─────────────────────────────────────────────────────────

const teile = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(empfangen?.kopf.authorization ?? '');
check('VAPID-Header hat die vorgeschriebene Form', Boolean(teile),
  String(empfangen?.kopf.authorization).slice(0, 40));
check('der mitgeschickte Schlüssel ist der öffentliche', teile?.[4] === paar.oeffentlich);

const rumpf = JSON.parse(Buffer.from(teile[2], 'base64url').toString());
check('das JWT gilt dem Push-Dienst, nicht dem Gerät',
  rumpf.aud === `http://127.0.0.1:${dienst.address().port}`, rumpf.aud);
check('das JWT läuft ab', rumpf.exp > Math.floor(Date.now() / 1000)
  && rumpf.exp <= Math.floor(Date.now() / 1000) + 12 * 60 * 60);

const pruefKey = await crypto.subtle.importKey('raw',
  new Uint8Array(Buffer.from(paar.oeffentlich, 'base64url')),
  { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
check('die Signatur passt zum öffentlichen Schlüssel',
  await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pruefKey,
    new Uint8Array(Buffer.from(teile[3], 'base64url')),
    new TextEncoder().encode(`${teile[1]}.${teile[2]}`)));

// ── Der Rumpf: nur das Gerät kann ihn lesen ─────────────────────────────────

const enc = new TextEncoder();
const kette = (...t) => {
  const o = new Uint8Array(t.reduce((n, x) => n + x.length, 0));
  let i = 0; for (const x of t) { o.set(x, i); i += x.length; }
  return o;
};
async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}

const koerper  = new Uint8Array(empfangen.koerper);
const salz     = koerper.subarray(0, 16);
const idlen    = koerper[20];
const serverP  = koerper.subarray(21, 21 + idlen);
const chiffre  = koerper.subarray(21 + idlen);

check('Kopf trägt den unkomprimierten Serverschlüssel', idlen === 65, String(idlen));
check('der Klartext steht nicht im Rumpf',
  !empfangen.koerper.includes(Buffer.from('Ümlaut', 'utf8')));

const serverKey = await crypto.subtle.importKey('raw', serverP, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
const gemeinsam = new Uint8Array(await crypto.subtle.deriveBits(
  { name: 'ECDH', public: serverKey }, geraet.privateKey, 256));
const ikm = await hkdf(geraetAuth, gemeinsam,
  kette(enc.encode('WebPush: info\0'), geraetPub, serverP), 32);
const cek   = await hkdf(salz, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
const nonce = await hkdf(salz, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

let entschluesselt = null;
try {
  const k = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const roh = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, k, chiffre));
  check('letzter Datensatz ist als solcher markiert', roh[roh.length - 1] === 2, String(roh[roh.length - 1]));
  entschluesselt = new TextDecoder().decode(roh.subarray(0, roh.length - 1));
} catch (err) {
  check('Nachricht lässt sich mit dem Geräteschlüssel entschlüsseln', false, err.message);
}
check('Nachricht kommt unverändert beim Gerät an', entschluesselt === nutzlast,
  String(entschluesselt).slice(0, 60));

// Ein fremdes Gerät darf nichts damit anfangen können.
const fremd = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const fremdGemeinsam = new Uint8Array(await crypto.subtle.deriveBits(
  { name: 'ECDH', public: serverKey }, fremd.privateKey, 256));
const fremdIkm = await hkdf(geraetAuth, fremdGemeinsam,
  kette(enc.encode('WebPush: info\0'), geraetPub, serverP), 32);
const fremdCek = await hkdf(salz, fremdIkm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
let fremdKlappt = false;
try {
  const k = await crypto.subtle.importKey('raw', fremdCek, 'AES-GCM', false, ['decrypt']);
  await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, k, chiffre);
  fremdKlappt = true;
} catch { /* genau so soll es sein */ }
check('ein anderer Schlüssel öffnet sie nicht', !fremdKlappt);

// Zweimal dieselbe Nachricht darf nicht zweimal gleich aussehen.
empfangen = null;
await senden({ ...abo, endpoint: dienstAdresse }, nutzlast, testEnv);
const zweiter = new Uint8Array(empfangen.koerper);
check('jede Nachricht bekommt ein eigenes Salz',
  Buffer.compare(Buffer.from(salz), Buffer.from(zweiter.subarray(0, 16))) !== 0);
check('jede Nachricht bekommt einen eigenen Serverschlüssel',
  Buffer.compare(Buffer.from(serverP), Buffer.from(zweiter.subarray(21, 86))) !== 0);

// Ein Gerät, das sein Abo weggeworfen hat, meldet 410 – daran erkennt der
// Aufräumteil, dass die Zeile weg kann.
antwortStatus = 410;
const tot = await senden({ ...abo, endpoint: dienstAdresse }, nutzlast, testEnv);
check('ein weggeworfenes Abo ist am Status erkennbar', tot.status === 410, 'HTTP ' + tot.status);

dienst.close();

console.log('\nText der Benachrichtigung');

check('eine Datei wird im Singular gemeldet',
  meldung(['eins.txt'], 0).titel === 'Eine Datei angekommen', meldung(['eins.txt'], 0).titel);
check('mehrere werden gezählt',
  meldung(['a', 'b', 'c'], 0).titel === '3 Dateien angekommen', meldung(['a', 'b', 'c'], 0).titel);
check('Dateien und Texte zusammen',
  meldung(['a'], 2).titel === 'Eine Datei und 2 Texte angekommen', meldung(['a'], 2).titel);
check('nur Texte',
  meldung([], 1).titel === 'Ein Text angekommen', meldung([], 1).titel);
check('der Name der neuesten Datei ist die Vorschau',
  meldung(['neu.txt', 'alt.txt'], 0).text === 'neu.txt');

console.log('\nZugriff von veerka.mp aus (CORS)');

// Die Kachel auf veerka.mp wirft direkt aus ihrem Dialog ein. Erlaubt sein
// darf dabei genau der Weg zum Einwerfen – und keiner zurück.
const vorab = (pfad, herkunft, methode = 'POST', base = UP) =>
  fetch(base + pfad, {
    method: 'OPTIONS',
    headers: {
      Origin: herkunft,
      'Access-Control-Request-Method': methode,
      'Access-Control-Request-Headers': 'content-type',
    },
  });

const initVorab = await vorab('/api/upload/init', 'https://veerka.mp');
check('die Vorabfrage von veerka.mp wird beantwortet',
  initVorab.headers.get('access-control-allow-origin') === 'https://veerka.mp',
  `HTTP ${initVorab.status}, ${initVorab.headers.get('access-control-allow-origin')}`);
check('das Teilstück darf per PUT kommen',
  (initVorab.headers.get('access-control-allow-methods') || '').includes('PUT'));
check('ein Sitzungstoken nützt von fremd nichts',
  !(initVorab.headers.get('access-control-allow-headers') || '').toLowerCase().includes('authorization'),
  initVorab.headers.get('access-control-allow-headers'));
check('die Antwort ist als herkunftsabhängig gekennzeichnet',
  (initVorab.headers.get('vary') || '').toLowerCase().includes('origin'),
  initVorab.headers.get('vary'));

const fremdVorab = await vorab('/api/upload/init', 'https://boese.example');
check('eine fremde Seite bekommt die Erlaubnis nicht',
  !fremdVorab.headers.get('access-control-allow-origin'),
  fremdVorab.headers.get('access-control-allow-origin'));

const statusCors = await fetch(UP + '/api/status', { headers: { Origin: 'https://veerka.mp' } });
check('auch die echte Antwort trägt die Erlaubnis',
  statusCors.headers.get('access-control-allow-origin') === 'https://veerka.mp');

const unlockVorab = await vorab('/api/unlock', 'https://veerka.mp');
check('freischalten geht von veerka.mp aus nicht',
  !unlockVorab.headers.get('access-control-allow-origin'),
  unlockVorab.headers.get('access-control-allow-origin'));

const dateienVorab = await vorab('/api/files', 'https://veerka.mp', 'GET', DL);
check('die Abhol-Adresse gibt gar nichts nach fremd heraus',
  !dateienVorab.headers.get('access-control-allow-origin'),
  dateienVorab.headers.get('access-control-allow-origin'));

const einwurfCors = await fetch(UP + '/api/note', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'https://veerka.mp' },
  body: JSON.stringify({ text: TEST_PREFIX + 'aus dem Dialog auf veerka.mp' }),
});
check('ein Text aus dem Dialog kommt an',
  einwurfCors.ok && einwurfCors.headers.get('access-control-allow-origin') === 'https://veerka.mp',
  'HTTP ' + einwurfCors.status);

console.log('\nTageskontingent');

const statusNow = await (await fetch(UP + '/api/status')).json();
check('Kontingent zählt die Uploads mit',
  statusNow.filesRemainingToday < statusNow.filesPerDay,
  `noch ${statusNow.filesRemainingToday} von ${statusNow.filesPerDay}`);
check('freigeschaltete Uploads zählen nicht gegen das Kontingent',
  statusUp.filesRemainingToday === null, JSON.stringify(statusUp.filesRemainingToday));

console.log(`\n${passed} bestanden, ${failed} fehlgeschlagen\n`);
process.exit(failed ? 1 : 0);
