// Web Push – RFC 8030 (Zustellung), 8291 (Verschlüsselung), 8292 (VAPID).
//
// Alles über WebCrypto, keine Abhängigkeiten. Der Ablauf ist in drei Schritten
// zu lesen:
//
//   1. Der Browser meldet sich beim Push-Dienst seines Herstellers an und gibt
//      uns dessen Adresse plus zwei Schlüssel. Das steht in der Datenbank.
//   2. Wir verschlüsseln die Nachricht für genau dieses Gerät. Der Push-Dienst
//      leitet sie weiter, kann sie aber nicht lesen – Google sieht, dass da
//      etwas ankommt, nicht was.
//   3. Damit der Dienst überhaupt etwas von uns annimmt, liegt ein signiertes
//      JWT dabei (VAPID). Es sagt: dieselbe Partei, die das Abo angelegt hat,
//      schickt jetzt auch.

import { b64urlEncode, b64urlDecode } from './crypto.js';

const enc = new TextEncoder();

function verketten(...teile) {
  const out = new Uint8Array(teile.reduce((n, t) => n + t.length, 0));
  let i = 0;
  for (const t of teile) { out.set(t, i); i += t.length; }
  return out;
}

async function hkdf(salt, ikm, info, laenge) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info }, key, laenge * 8,
  ));
}

// ── VAPID (RFC 8292) ────────────────────────────────────────────────────────

/**
 * Erzeugt ein Schlüsselpaar für die Anmeldung beim Push-Dienst.
 *
 * Läuft einmalig in tools/make-vapid.mjs, nicht im Worker: der öffentliche
 * Teil geht an den Browser, der geheime bleibt als Secret liegen. Ein Wechsel
 * macht alle bestehenden Abos ungültig.
 */
export async function vapidSchluesselpaar() {
  const paar = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
  );
  return {
    oeffentlich: b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', paar.publicKey))),
    geheim:      b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('pkcs8', paar.privateKey))),
  };
}

/**
 * Baut den Authorization-Header für eine Zustellung.
 *
 * Das JWT gilt dem Push-Dienst, nicht dem Gerät: `aud` ist dessen Herkunft,
 * mehr steht nicht drin. Zwölf Stunden Laufzeit, weil manche Dienste alles
 * darüber ablehnen.
 */
export async function vapidKopf(endpoint, oeffentlich, geheim, kontakt) {
  const kopf  = b64urlEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const rumpf = b64urlEncode(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: kontakt,
  })));

  const key = await crypto.subtle.importKey(
    'pkcs8', b64urlDecode(geheim), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
  );
  // WebCrypto liefert die Signatur bereits als r‖s – genau das erwartet ES256.
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${kopf}.${rumpf}`),
  ));

  return `vapid t=${kopf}.${rumpf}.${b64urlEncode(sig)}, k=${oeffentlich}`;
}

// ── Nutzlast verschlüsseln (RFC 8291 über RFC 8188) ─────────────────────────

// Ein einzelner Datensatz reicht: die Push-Dienste nehmen ohnehin nur gut vier
// Kilobyte, und so viel hat eine Benachrichtigung nie.
const DATENSATZGROESSE = 4096;

/**
 * Verschlüsselt Text für genau ein Gerät.
 *
 * Das Ergebnis ist der komplette HTTP-Rumpf: erst ein Kopf mit Salz und
 * unserem Wegwerf-Schlüssel, dann der verschlüsselte Datensatz. Ohne den
 * geheimen Teil des Browser-Schlüssels lässt sich daraus nichts machen.
 */
export async function verschluesseln(p256dh, auth, klartext) {
  const geraetSchluessel = b64urlDecode(p256dh);
  const geraetGeheimnis  = b64urlDecode(auth);

  // Für jede Nachricht ein frisches Wegwerf-Paar. Wird es wiederverwendet,
  // ergibt sich für dasselbe Gerät immer derselbe Schlüssel.
  const eigen = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  );
  const eigenSchluessel = new Uint8Array(await crypto.subtle.exportKey('raw', eigen.publicKey));

  const fremd = await crypto.subtle.importKey(
    'raw', geraetSchluessel, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
  const gemeinsam = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: fremd }, eigen.privateKey, 256,
  ));

  // RFC 8291 §3.4: aus dem gemeinsamen Geheimnis und beiden öffentlichen
  // Schlüsseln wird das Ausgangsmaterial – dass beide Schlüssel eingehen,
  // bindet die Nachricht an genau dieses Gerätepaar.
  const ikm = await hkdf(
    geraetGeheimnis, gemeinsam,
    verketten(enc.encode('WebPush: info\0'), geraetSchluessel, eigenSchluessel), 32,
  );

  const salz  = crypto.getRandomValues(new Uint8Array(16));
  const cek   = await hkdf(salz, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salz, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // 0x02 schließt den letzten Datensatz ab (RFC 8188 §2). Bei uns ist der
  // letzte immer auch der einzige.
  const chiffre = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce }, key,
    verketten(enc.encode(klartext), new Uint8Array([2])),
  ));

  // Kopf: Salz (16) | Datensatzgröße (4) | Länge des Schlüssels (1) | Schlüssel
  const kopf = new Uint8Array(21);
  kopf.set(salz, 0);
  new DataView(kopf.buffer).setUint32(16, DATENSATZGROESSE);
  kopf[20] = eigenSchluessel.length;

  return verketten(kopf, eigenSchluessel, chiffre);
}

// ── Zustellen ───────────────────────────────────────────────────────────────

/**
 * Schickt eine Nachricht an ein Abo.
 *
 * Gibt die Antwort des Push-Dienstes zurück. 404 und 410 bedeuten: das Gerät
 * hat das Abo weggeworfen – dann gehört die Zeile gelöscht, sonst sammeln sich
 * tote Abos an, die bei jedem Lauf erfolglos angeschrieben werden.
 */
export async function senden(abo, nutzlast, env) {
  const koerper = await verschluesseln(abo.p256dh, abo.auth, nutzlast);
  const kopf = await vapidKopf(
    abo.endpoint, env.VAPID_PUBLIC, env.VAPID_PRIVATE,
    env.VAPID_SUBJECT || 'https://download.veerka.mp',
  );

  return fetch(abo.endpoint, {
    method: 'POST',
    headers: {
      Authorization: kopf,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      // Einen Tag aufheben, falls das Handy gerade aus ist.
      TTL: '86400',
    },
    body: koerper,
  });
}
