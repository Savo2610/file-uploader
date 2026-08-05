// Zwei-Faktor-Codes und Sitzungstoken – alles über WebCrypto, keine Abhängigkeiten.

const enc = new TextEncoder();

// ── Hilfsfunktionen ─────────────────────────────────────────────────────────

export function b64urlEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

export function randomToken(bytes = 32) {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Vergleich in konstanter Zeit. Ein normales === bricht beim ersten
// abweichenden Zeichen ab; aus der Laufzeit ließe sich ein Token Zeichen für
// Zeichen erraten.
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── TOTP (RFC 6238) ─────────────────────────────────────────────────────────

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/[=\s-]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx === -1) throw new Error('Ungültiges Zeichen im Base32-Secret: ' + ch);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function base32Encode(bytes) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

const TOTP_STEP_SECONDS = 30;

async function hotp(secretBytes, counter) {
  const key = await crypto.subtle.importKey(
    'raw', secretBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
  );
  // Zählerstand als 8 Byte, big endian.
  const msg = new ArrayBuffer(8);
  const view = new DataView(msg);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);

  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  // Dynamic Truncation: die letzten 4 Bit zeigen auf die 4 Bytes, die zählen.
  const offset = sig[sig.length - 1] & 0x0f;
  const bin =
    ((sig[offset] & 0x7f) << 24) |
    (sig[offset + 1] << 16) |
    (sig[offset + 2] << 8) |
    sig[offset + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

/**
 * Prüft einen 6-stelligen Code gegen das Secret.
 *
 * `window` erlaubt Nachbar-Zeitfenster, damit eine leicht falsch gestellte
 * Handy-Uhr oder ein Code, der beim Abtippen gerade abläuft, nicht scheitert.
 * Gibt bei Erfolg das getroffene Zeitfenster zurück – das geht in die
 * Wiederverwendungssperre ein.
 */
export async function verifyTotp(secretBase32, code, { window = 1, now = Date.now() } = {}) {
  if (!/^\d{6}$/.test(String(code || '').trim())) return null;
  const secret = base32Decode(secretBase32);
  const counter = Math.floor(now / 1000 / TOTP_STEP_SECONDS);
  for (let drift = -window; drift <= window; drift++) {
    const expected = await hotp(secret, counter + drift);
    if (timingSafeEqual(expected, String(code).trim())) {
      return { counter: counter + drift };
    }
  }
  return null;
}

// ── Sitzungstoken ───────────────────────────────────────────────────────────
//
// Nach erfolgreicher 2FA bekommt der Browser ein signiertes Token. Der Server
// merkt sich dafür nichts: die Signatur belegt, dass das Token von uns kommt,
// und das Ablaufdatum steckt mit drin.

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
}

export async function signSession(secret, ttlSeconds) {
  const payload = b64urlEncode(enc.encode(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    // Die ursprüngliche Laufzeit steht mit im Token. Ohne sie ließe sich beim
    // Verlängern nicht sagen, ob eine halbe Stunde oder ein halber Monat
    // Restlaufzeit „schon fast abgelaufen“ heißt.
    ttl: ttlSeconds,
    jti: randomToken(8),
  })));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload)));
  return `${payload}.${b64urlEncode(sig)}`;
}

export async function verifySession(secret, token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.', 2);
  if (!payload || !sig) return null;

  const expected = new Uint8Array(
    await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload)),
  );
  if (!timingSafeEqual(b64urlEncode(expected), sig)) return null;

  let data;
  try { data = JSON.parse(new TextDecoder().decode(b64urlDecode(payload))); }
  catch { return null; }

  if (!data || typeof data.exp !== 'number') return null;
  if (data.exp < Math.floor(Date.now() / 1000)) return null;
  return data;
}
