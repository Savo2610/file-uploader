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
// Dieselben Töne wie public/style.css.

const BG    = [0x14, 0x12, 0x0e];
const GOLD  = [0xc9, 0xa8, 0x4c];
const RAND  = [0x3a, 0x33, 0x22];

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
    // bisherige Bild (Alpha-Blending, „source over“).
    paint(color, alpha, deckung) {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const a = alpha * deckung(x + 0.5, y + 0.5);
          if (a <= 0) continue;
          const i = (y * size + x) * 4;
          const dst = data[i + 3] / 255;
          const out = a + dst * (1 - a);
          for (let k = 0; k < 3; k++) {
            data[i + k] = Math.round((color[k] * a + data[i + k] * dst * (1 - a)) / out);
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

/**
 * Das Symbol: ein Pfeil, der in eine offene Schale zeigt – dieselbe Figur wie
 * auf der Upload-Seite, nur andersherum, weil hier abgeholt wird.
 *
 * `scale` ist die Kantenlänge der Figur im Verhältnis zum Bild. Bei maskable
 * schneiden manche Startbildschirme bis zu 20 % ringsum weg, deshalb dort
 * kleiner.
 */
function glyph(c, scale) {
  const s = c.size;
  const u = s * scale;              // Kantenlänge der Figur
  const ox = (s - u) / 2, oy = (s - u) / 2;
  const P = (x, y) => [ox + x * u, oy + y * u];
  const w = u * 0.075;              // halbe Strichstärke

  const [ax1, ay1] = P(0.5, 0.06),  [ax2, ay2] = P(0.5, 0.60);
  const [lx,  ly]  = P(0.28, 0.40), [rx,  ry]  = P(0.72, 0.40);
  const [tl1, tl2] = P(0.10, 0.62), [tb1, tb2] = P(0.10, 0.92);
  const [tr1, tr2] = P(0.90, 0.62), [tc1, tc2] = P(0.90, 0.92);

  c.paint(GOLD, 1, (x, y) => fill(Math.min(
    // Pfeil: Schaft und zwei Schenkel der Spitze.
    sdSegment(x, y, ax1, ay1, ax2, ay2),
    sdSegment(x, y, lx, ly, ax2, ay2),
    sdSegment(x, y, rx, ry, ax2, ay2),
    // Schale: links herunter, unten herüber, rechts hinauf.
    sdSegment(x, y, tl1, tl2, tb1, tb2),
    sdSegment(x, y, tb1, tb2, tc1, tc2),
    sdSegment(x, y, tc1, tc2, tr1, tr2),
  ) - w));
}

// Das Symbol für den Startbildschirm: abgerundete Kachel mit feiner Kante.
function kachel(size) {
  const c = canvas(size);
  const r = size * 0.22, h = size / 2;
  c.paint(BG, 1, (x, y) => fill(sdRoundRect(x, y, h, h, h - size * 0.02, h - size * 0.02, r)));
  // Kante: die Fläche minus die um eine Strichstärke kleinere Fläche.
  const b = size * 0.012;
  c.paint(RAND, 1, (x, y) => {
    const d = sdRoundRect(x, y, h, h, h - size * 0.02, h - size * 0.02, r);
    return fill(d) - fill(d + b);
  });
  glyph(c, 0.56);
  return png(size, size, c.data);
}

// Maskable: randlos, weil der Startbildschirm selbst zuschneidet.
function randlos(size, scale) {
  const c = canvas(size);
  c.paint(BG, 1, () => 1);
  glyph(c, scale);
  return png(size, size, c.data);
}

// ── Los ─────────────────────────────────────────────────────────────────────

mkdirSync(OUT, { recursive: true });

const dateien = {
  'abholen-192.png':           kachel(192),
  'abholen-512.png':           kachel(512),
  'abholen-maskable-192.png':  randlos(192, 0.46),
  'abholen-maskable-512.png':  randlos(512, 0.46),
  // iOS legt selbst runde Ecken an und mag kein Transparenz – deshalb randlos.
  'abholen-apple-180.png':     randlos(180, 0.54),
};

for (const [name, buf] of Object.entries(dateien)) {
  writeFileSync(new URL(name, OUT), buf);
  console.log(`${name}  ${(buf.length / 1024).toFixed(1)} KB`);
}
