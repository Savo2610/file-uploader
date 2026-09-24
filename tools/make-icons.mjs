// Erzeugt die PWA-Symbole in public/icons/.
//
//   node tools/make-icons.mjs
//
// Die fertigen PNGs liegen im Repo – dieses Skript muss also nur laufen, wenn
// sich am Symbol etwas ändern soll. Es zeichnet direkt in Pixel und schreibt
// das PNG von Hand, damit für ein paar Quadrate kein Bildpaket nötig ist.
//
// Warum überhaupt PNG: Android baut aus einer Seite nur dann eine echte App
// (mit eigenem Symbol) statt einer Verknüpfung (mit Chrome-Logo in der Ecke),
// wenn das Manifest 192er und 512er Rastergrafiken anbietet. SVG reicht dafür
// nicht zuverlässig.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = new URL('../public/icons/', import.meta.url);

// ── Farben ──────────────────────────────────────────────────────────────────
// Dieselben Töne wie public/style.css und die Rohrpost in public/rohrpost.js.

const HIMMEL_OBEN  = [0x5f, 0xa8, 0xf0];
const HIMMEL_UNTEN = [0xc4, 0xe4, 0xfc];
const WEISS   = [0xff, 0xff, 0xff];
const KANTE   = [0x3d, 0x7f, 0xc4];
const KORALLE = [0xff, 0x6b, 0x5a];
const CHROM   = [0xe6, 0xed, 0xf5];
const GUMMI   = [0x2b, 0x31, 0x50];
const MESSING = [0xf0, 0xbd, 0x55];

// ── PNG schreiben ───────────────────────────────────────────────────────────

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8]  = 8;  // 8 Bit je Kanal
  ihdr[9]  = 6;  // RGBA
  // 10–12: Kompression, Filter, Interlace – jeweils der einzige erlaubte Wert.

  // Jede Zeile bekommt ein führendes Filter-Byte 0 („kein Filter“).
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Zeichnen ────────────────────────────────────────────────────────────────
//
// Statt eines Rasterisierers: für jede Form eine Abstandsfunktion. Der Abstand
// zum Rand ergibt direkt die Deckung des Pixels – das glättet die Kanten, ohne
// dass mehrfach abgetastet werden müsste.

// Abstand zu einem Rechteck mit runden Ecken.
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// Abstand zu einer Strecke. Mit einer Strichstärke wird daraus ein Strich mit
// runden Enden – und wo zwei Striche aneinanderstoßen, eine runde Ecke.
function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax, pay = py - ay;
  const bax = bx - ax, bay = by - ay;
  const len = bax * bax + bay * bay;
  const h = len === 0 ? 0 : Math.min(1, Math.max(0, (pax * bax + pay * bay) / len));
  return Math.hypot(pax - bax * h, pay - bay * h);
}

function canvas(size) {
  const data = Buffer.alloc(size * size * 4); // durchsichtig
  return {
    size,
    data,
    // Malt eine Farbe dort, wo `deckung(x, y)` zwischen 0 und 1 liegt, über das
    // bisherige Bild (Alpha-Blending, „source over“). Die Farbe darf auch eine
    // Funktion des Ortes sein – für Verläufe.
    paint(color, alpha, deckung) {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const a = alpha * deckung(x + 0.5, y + 0.5);
          if (a <= 0) continue;
          const c = typeof color === 'function' ? color(x + 0.5, y + 0.5) : color;
          const i = (y * size + x) * 4;
          const dst = data[i + 3] / 255;
          const out = a + dst * (1 - a);
          for (let k = 0; k < 3; k++) {
            data[i + k] = Math.round((c[k] * a + data[i + k] * dst * (1 - a)) / out);
          }
          data[i + 3] = Math.round(out * 255);
        }
      }
    },
  };
}

// Aus einem Abstand wird eine Deckung: innerhalb voll, außerhalb nichts, auf
// der Breite eines Pixels weich dazwischen.
const fill = d => Math.min(1, Math.max(0, 0.5 - d));

const mix = (a, b, t) => a.map((v, k) => v + (b[k] - v) * t);

// Himmel: oben kräftiges Blau, unten fast weiß, links oben ein Sonnenschein.
function himmel(c, form) {
  const s = c.size;
  c.paint((x, y) => mix(HIMMEL_OBEN, HIMMEL_UNTEN, y / s), 1, form);
  c.paint(WEISS, 0.45, (x, y) => Math.max(0, 1 - Math.hypot(x - s * 0.12, y - s * 0.05) / (s * 0.55)) * form(x, y));
}

/**
 * Das Motiv: eine Rohrpost-Kapsel, die schräg durch eine Glasröhre saust –
 * dieselbe wie auf den Seiten. `k` ist die Größe der Kapsel im Verhältnis zum
 * Bild; bei maskable schneiden manche Startbildschirme bis zu 20 % ringsum
 * weg, deshalb dort kleiner. Die Röhre darf angeschnitten werden.
 */
function rohrpost(c, k) {
  const s = c.size;
  // Achse der Röhre: schräg von links unten nach rechts oben.
  const mx = s * 0.5, my = s * 0.53;
  const len = Math.hypot(1, 0.46);
  const dx = 1 / len, dy = -0.46 / len;
  // Längs- (u) und Querkoordinate (v) zur Achse, in Bildgrößen.
  const uv = (x, y) => {
    const px = (x - mx) / s, py = (y - my) / s;
    return [px * dx + py * dy, -px * dy + py * dx];
  };
  const R = 0.2 * k / 0.62;         // Innenradius der Röhre
  const L = 0.3 * k / 0.62;         // halbe Länge der Kapsel
  const r = 0.125 * k / 0.62;       // Radius der Kapsel
  const px = 1 / s;                 // ein Pixel in Bildgrößen

  // Glas: fast durchsichtig, zum Rand hin heller.
  c.paint(WEISS, 1, (x, y) => {
    const [, v] = uv(x, y);
    const d = Math.abs(v) / R;
    return d > 1 ? fill((Math.abs(v) - R) / px) * 0.2 : 0.14 + Math.pow(d, 4) * 0.35;
  });

  // Fahrtstreifen hinter der Kapsel.
  for (const [v0, l0, l1] of [[-0.5, -1.55, -1.1], [0.05, -1.85, -1.1], [0.55, -1.45, -1.1]]) {
    c.paint(WEISS, 0.85, (x, y) => {
      const [u, v] = uv(x, y);
      return fill((sdSegment(u, v, l0 * L, v0 * r, l1 * L, v0 * r) - 0.012) / px);
    });
  }

  // Die Kapsel: Lack, Chromkappen, weißes Band, zwei Gummiringe.
  const kapsel = (u, v) => sdSegment(u, v, -L + r, 0, L - r, 0) - r;
  c.paint(KORALLE, 1, (x, y) => fill(kapsel(...uv(x, y)) / px));
  c.paint(CHROM, 1, (x, y) => {
    const [u, v] = uv(x, y);
    return fill(kapsel(u, v) / px) * fill((L - 0.075 - Math.abs(u)) / px);
  });
  c.paint(WEISS, 1, (x, y) => {
    const [u, v] = uv(x, y);
    return fill(kapsel(u, v) / px) * fill((Math.abs(u - 0.02) - 0.035) / px);
  });
  for (const u0 of [-L * 0.62, L * 0.62]) {
    c.paint(GUMMI, 1, (x, y) => {
      const [u, v] = uv(x, y);
      return fill((sdSegment(u, v, u0, -r - 0.012, u0, r + 0.012) - 0.018) / px);
    });
  }
  // Glanzlicht oben auf der Kapsel.
  c.paint(WEISS, 0.55, (x, y) => {
    const [u, v] = uv(x, y);
    return fill((sdSegment(u, v, -L * 0.45, -r * 0.55, L * 0.3, -r * 0.55) - 0.012) / px);
  });

  // Röhrenkanten: innen ein Glanzstreifen, außen ein blauer Umriss.
  c.paint(KANTE, 0.8, (x, y) => {
    const [, v] = uv(x, y);
    return fill((Math.abs(Math.abs(v) - R) - 0.012) / px);
  });
  c.paint(WEISS, 0.9, (x, y) => {
    const [, v] = uv(x, y);
    return fill((Math.abs(v + R * 0.72) - 0.01) / px);
  });

  // Zwei Messingschellen.
  for (const u0 of [-0.36, 0.36]) {
    c.paint(MESSING, 1, (x, y) => {
      const [u, v] = uv(x, y);
      return fill((sdSegment(u, v, u0, -R - 0.022, u0, R + 0.022) - 0.017) / px);
    });
  }
}

// Das Symbol für den Startbildschirm: abgerundete Kachel.
function kachel(size) {
  const c = canvas(size);
  const r = size * 0.22, h = size / 2;
  const form = (x, y) => fill(sdRoundRect(x, y, h, h, h - size * 0.02, h - size * 0.02, r));
  himmel(c, form);
  const motiv = canvas(size);
  rohrpost(motiv, 0.62);
  // Das Motiv nur innerhalb der Kachel.
  for (let i = 0; i < size * size; i++) {
    const x = i % size, y = Math.floor(i / size);
    motiv.data[i * 4 + 3] = Math.round(motiv.data[i * 4 + 3] * form(x + 0.5, y + 0.5));
  }
  c.paint((x, y) => {
    const i = (Math.floor(y) * size + Math.floor(x)) * 4;
    return [motiv.data[i], motiv.data[i + 1], motiv.data[i + 2]];
  }, 1, (x, y) => motiv.data[(Math.floor(y) * size + Math.floor(x)) * 4 + 3] / 255);
  return png(size, size, c.data);
}

// Maskable und Apple: randlos, weil der Startbildschirm selbst zuschneidet.
function randlos(size, k) {
  const c = canvas(size);
  himmel(c, () => 1);
  rohrpost(c, k);
  return png(size, size, c.data);
}

// ── Los ─────────────────────────────────────────────────────────────────────

mkdirSync(OUT, { recursive: true });

const dateien = {
  'abholen-192.png':           kachel(192),
  'abholen-512.png':           kachel(512),
  'abholen-maskable-192.png':  randlos(192, 0.5),
  'abholen-maskable-512.png':  randlos(512, 0.5),
  // iOS legt selbst runde Ecken an und mag keine Transparenz – deshalb randlos.
  'abholen-apple-180.png':     randlos(180, 0.6),
};

for (const [name, buf] of Object.entries(dateien)) {
  writeFileSync(new URL(name, OUT), buf);
  console.log(`${name}  ${(buf.length / 1024).toFixed(1)} KB`);
}
