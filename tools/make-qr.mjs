// Erzeugt den QR-Code in public/qr.svg – er zeigt auf upload.veerka.mp.
//
//   node tools/make-qr.mjs
//
// Gedacht zum Herzeigen: die Abhol-Seite blendet ihn ein, jemand hält sein
// Handy davor und landet im Briefkasten, ohne die Adresse abtippen zu müssen.
//
// Die Adresse steht fest, also muss auch kein Encoder in die Seite: der Code
// wird einmal hier gezeichnet, liegt als SVG im Repo und wird nur noch
// angezeigt. Das spart dem Browser eine Bibliothek für etwas, das sich nie
// ändert – und die Richtigkeit ist einmalig geprüft statt bei jedem Aufruf
// gehofft.
//
// Nach ISO/IEC 18004, nur Byte-Modus und nur so viele Versionen, wie eine
// kurze Adresse braucht. Ohne Abhängigkeiten, wie alles hier.

import { writeFileSync } from 'node:fs';

const ZIEL = process.argv[2] || 'https://upload.veerka.mp';
const DATEI = new URL('../public/qr.svg', import.meta.url);

// ── Tabellen aus der Norm ───────────────────────────────────────────────────

// Gesamtzahl der Codewörter je Version (Daten + Fehlerkorrektur).
const CODEWOERTER = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

// Je Version und Stufe: [ECC je Block, Blöcke Gruppe 1, Daten je Block,
// Blöcke Gruppe 2, Daten je Block]. Gruppe 2 hat immer ein Datenwort mehr.
const BLOECKE = {
  L: [[7,1,19,0,0],[10,1,34,0,0],[15,1,55,0,0],[20,1,80,0,0],[26,1,108,0,0],
      [18,2,68,0,0],[20,2,78,0,0],[24,2,97,0,0],[30,2,116,0,0],[18,2,68,2,69]],
  M: [[10,1,16,0,0],[16,1,28,0,0],[26,1,44,0,0],[18,2,32,0,0],[24,2,43,0,0],
      [16,4,27,0,0],[18,4,31,0,0],[22,2,38,2,39],[22,3,36,2,37],[26,4,43,1,44]],
  Q: [[13,1,13,0,0],[22,1,22,0,0],[18,2,17,0,0],[26,2,24,0,0],[18,2,15,2,16],
      [24,4,19,0,0],[18,2,14,4,15],[22,4,18,2,19],[20,4,16,4,17],[24,6,19,2,20]],
  H: [[17,1,9,0,0],[28,1,16,0,0],[22,2,13,0,0],[16,4,9,0,0],[22,2,11,2,12],
      [28,4,15,0,0],[26,4,13,1,14],[26,4,14,2,15],[24,4,12,4,13],[28,6,15,2,16]],
};

// Mittelpunkte der Ausrichtungsmuster je Version.
const AUSRICHTUNG = [
  [], [6,18], [6,22], [6,26], [6,30], [6,34], [6,22,38], [6,24,42], [6,26,46], [6,28,50],
];

const STUFE_BITS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };

// Gegenprobe zur Tabelle: Daten plus Fehlerkorrektur muss die Gesamtzahl
// ergeben. Ein Zahlendreher oben fällt damit sofort auf, statt sich in einem
// Code zu verstecken, den kein Gerät liest.
for (const [stufe, zeilen] of Object.entries(BLOECKE)) {
  zeilen.forEach(([ecc, b1, d1, b2, d2], i) => {
    const summe = (b1 + b2) * ecc + b1 * d1 + b2 * d2;
    if (summe !== CODEWOERTER[i]) {
      throw new Error(`Tabelle falsch: Version ${i + 1}${stufe} ergibt ${summe} statt ${CODEWOERTER[i]}`);
    }
  });
}

// ── Rechnen in GF(256) ──────────────────────────────────────────────────────
//
// Reed-Solomon lebt in einem endlichen Körper mit 256 Elementen. Multiplizieren
// heißt dort: Logarithmen addieren. Deshalb einmal beide Tabellen aufbauen.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;   // das Restpolynom der Norm
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];

const mal = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

// Das Generatorpolynom für n Fehlerkorrekturwörter: (x-α⁰)(x-α¹)…(x-αⁿ⁻¹)
function generator(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const naechste = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      naechste[j] ^= poly[j];
      naechste[j + 1] ^= mal(poly[j], EXP[i]);
    }
    poly = naechste;
  }
  return poly;
}

// Polynomdivision: der Rest sind die Fehlerkorrekturwörter.
function ecc(daten, anzahl) {
  const gen = generator(anzahl);
  const rest = new Array(anzahl).fill(0);
  for (const wort of daten) {
    const faktor = wort ^ rest[0];
    rest.shift();
    rest.push(0);
    for (let i = 0; i < anzahl; i++) rest[i] ^= mal(gen[i + 1], faktor);
  }
  return rest;
}

// ── Daten zu Codewörtern ────────────────────────────────────────────────────

function codewoerter(text, stufe) {
  const bytes = [...new TextEncoder().encode(text)];

  // Die kleinste Version, in die es passt. Bis Version 9 ist die Längenangabe
  // im Byte-Modus 8 Bit lang, ab 10 sind es 16.
  let version = -1;
  for (let v = 1; v <= 10; v++) {
    const [eccProBlock, b1, d1, b2, d2] = BLOECKE[stufe][v - 1];
    const platz = b1 * d1 + b2 * d2;
    const gebraucht = Math.ceil((4 + (v < 10 ? 8 : 16) + bytes.length * 8) / 8);
    if (gebraucht <= platz) { version = v; break; }
  }
  if (version === -1) throw new Error('Zu lang für Version 10 – hier ist nur eine Adresse vorgesehen.');

  const [eccProBlock, b1, d1, b2, d2] = BLOECKE[stufe][version - 1];
  const datenGesamt = b1 * d1 + b2 * d2;

  // Bitstrom: Modus, Länge, Nutzlast, Abschluss, Auffüllen.
  const bits = [];
  const schreibe = (wert, laenge) => {
    for (let i = laenge - 1; i >= 0; i--) bits.push((wert >> i) & 1);
  };

  schreibe(0b0100, 4);                                  // Byte-Modus
  schreibe(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) schreibe(b, 8);
  schreibe(0, Math.min(4, datenGesamt * 8 - bits.length));   // Abschluss
  while (bits.length % 8) bits.push(0);

  const daten = [];
  for (let i = 0; i < bits.length; i += 8) {
    daten.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  }
  // Die Norm schreibt genau diese zwei Füllbytes im Wechsel vor.
  for (let i = 0; daten.length < datenGesamt; i++) daten.push(i % 2 ? 0x11 : 0xec);

  // In Blöcke schneiden, je Block die Fehlerkorrektur rechnen.
  const datenBloecke = [], eccBloecke = [];
  let pos = 0;
  for (const [anzahl, groesse] of [[b1, d1], [b2, d2]]) {
    for (let i = 0; i < anzahl; i++) {
      const block = daten.slice(pos, pos + groesse);
      pos += groesse;
      datenBloecke.push(block);
      eccBloecke.push(ecc(block, eccProBlock));
    }
  }

  // Verschränken: erst spaltenweise die Datenwörter aller Blöcke, dann
  // ebenso die Fehlerkorrektur. Dadurch trifft ein Kratzer über dem Code
  // jeden Block nur ein wenig statt einen ganz.
  const folge = [];
  for (const bloecke of [datenBloecke, eccBloecke]) {
    const laengste = Math.max(...bloecke.map(b => b.length));
    for (let i = 0; i < laengste; i++) {
      for (const block of bloecke) if (i < block.length) folge.push(block[i]);
    }
  }

  return { version, folge };
}

// ── Das Muster legen ────────────────────────────────────────────────────────

function grundgeruest(version) {
  const n = version * 4 + 17;
  // null = noch frei, 0/1 = gesetzt. Zusätzlich merken, was Funktionsmuster
  // ist – dort darf später weder Datum landen noch maskiert werden.
  const feld = Array.from({ length: n }, () => new Array(n).fill(null));
  const fest = Array.from({ length: n }, () => new Array(n).fill(false));

  const setze = (x, y, wert) => {
    if (x < 0 || y < 0 || x >= n || y >= n) return;
    feld[y][x] = wert;
    fest[y][x] = true;
  };

  // Die drei Suchmuster mit ihrem Trennstreifen.
  for (const [ox, oy] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
    for (let y = -1; y <= 7; y++) {
      for (let x = -1; x <= 7; x++) {
        const rand = x === -1 || x === 7 || y === -1 || y === 7;
        const ring = x === 0 || x === 6 || y === 0 || y === 6;
        const kern = x >= 2 && x <= 4 && y >= 2 && y <= 4;
        setze(ox + x, oy + y, rand ? 0 : (ring || kern) ? 1 : 0);
      }
    }
  }

  // Die Ausrichtungsmuster – überall außer dort, wo schon ein Suchmuster steht.
  const mitten = AUSRICHTUNG[version - 1];
  for (const cy of mitten) {
    for (const cx of mitten) {
      if (fest[cy]?.[cx]) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const aussen = Math.max(Math.abs(dx), Math.abs(dy));
          setze(cx + dx, cy + dy, aussen === 1 ? 0 : 1);
        }
      }
    }
  }

  // Die beiden Taktlinien.
  for (let i = 8; i < n - 8; i++) {
    setze(i, 6, i % 2 === 0 ? 1 : 0);
    setze(6, i, i % 2 === 0 ? 1 : 0);
  }

  // Das immer dunkle Modul.
  setze(8, n - 8, 1);

  // Platz für die Formatangabe freihalten – Inhalt kommt später.
  for (let i = 0; i < 9; i++) { setze(i, 8, 0); setze(8, i, 0); }
  for (let i = 0; i < 8; i++) { setze(n - 1 - i, 8, 0); setze(8, n - 1 - i, 0); }

  // Ab Version 7 zusätzlich die Versionsangabe.
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      setze(i % 3 + n - 11, Math.floor(i / 3), 0);
      setze(Math.floor(i / 3), i % 3 + n - 11, 0);
    }
  }

  return { n, feld, fest };
}

// Die Codewörter im Zickzack von unten rechts nach oben links einlegen.
function lege(feld, fest, n, folge) {
  const bits = [];
  for (const wort of folge) for (let i = 7; i >= 0; i--) bits.push((wort >> i) & 1);

  let i = 0, aufwaerts = true;
  for (let rechts = n - 1; rechts >= 1; rechts -= 2) {
    // Spalte 6 ist die senkrechte Taktlinie und wird übersprungen.
    if (rechts === 6) rechts--;
    for (let schritt = 0; schritt < n; schritt++) {
      const y = aufwaerts ? n - 1 - schritt : schritt;
      for (const x of [rechts, rechts - 1]) {
        if (fest[y][x]) continue;
        // Bleiben Plätze übrig (die „Restbits“), füllt sie eine 0.
        feld[y][x] = i < bits.length ? bits[i++] : 0;
      }
    }
    aufwaerts = !aufwaerts;
  }
}

const MASKEN = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
  (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0,
  (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
];

// Die Norm bewertet vier Auffälligkeiten und nimmt die Maske mit der
// kleinsten Summe. Der Sinn: möglichst wenig, was ein Lesegerät mit einem
// Suchmuster verwechseln kann, und keine großen einfarbigen Flächen.
function strafe(feld, n) {
  let summe = 0;

  // 1. Reihen von fünf und mehr gleichen Modulen, waagerecht wie senkrecht.
  for (const waagerecht of [true, false]) {
    for (let a = 0; a < n; a++) {
      let lauf = 1;
      for (let b = 1; b < n; b++) {
        const jetzt  = waagerecht ? feld[a][b]     : feld[b][a];
        const vorher = waagerecht ? feld[a][b - 1] : feld[b - 1][a];
        if (jetzt === vorher) { lauf++; continue; }
        if (lauf >= 5) summe += 3 + (lauf - 5);
        lauf = 1;
      }
      if (lauf >= 5) summe += 3 + (lauf - 5);
    }
  }

  // 2. Gleichfarbige Zweier-Quadrate.
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const v = feld[y][x];
      if (v === feld[y][x + 1] && v === feld[y + 1][x] && v === feld[y + 1][x + 1]) summe += 3;
    }
  }

  // 3. Das Muster, das einem Suchmuster ähnelt – in beiden Leserichtungen.
  const A = [1,0,1,1,1,0,1,0,0,0,0], B = [0,0,0,0,1,0,1,1,1,0,1];
  for (const waagerecht of [true, false]) {
    for (let a = 0; a < n; a++) {
      for (let b = 0; b <= n - 11; b++) {
        const holen = k => (waagerecht ? feld[a][b + k] : feld[b + k][a]);
        if (A.every((v, k) => holen(k) === v)) summe += 40;
        if (B.every((v, k) => holen(k) === v)) summe += 40;
      }
    }
  }

  // 4. Abweichung vom halb-halb-Verhältnis zwischen hell und dunkel.
  const dunkel = feld.flat().filter(v => v === 1).length;
  summe += 10 * Math.floor(Math.abs(dunkel * 100 / (n * n) - 50) / 5);

  return summe;
}

// Formatangabe: 5 Bit Nutzinhalt, per BCH(15,5) auf 15 Bit gebracht, dann mit
// einer festen Maske verodert – sonst wäre die Angabe „Stufe M, Maske 0“
// lauter Nullen und damit selbst eine große helle Fläche.
function formatBits(stufe, maske) {
  const roh = (STUFE_BITS[stufe] << 3) | maske;
  let rest = roh << 10;
  for (let i = 4; i >= 0; i--) if ((rest >> (i + 10)) & 1) rest ^= 0x537 << i;
  return ((roh << 10) | rest) ^ 0x5412;
}

function versionBits(version) {
  let rest = version << 12;
  for (let i = 5; i >= 0; i--) if ((rest >> (i + 12)) & 1) rest ^= 0x1f25 << i;
  return (version << 12) | rest;
}

function bauen(text, stufe = 'Q') {
  const { version, folge } = codewoerter(text, stufe);
  const { n, feld, fest } = grundgeruest(version);
  lege(feld, fest, n, folge);

  // Alle acht Masken durchrechnen und die unauffälligste behalten.
  let beste = null;
  for (let maske = 0; maske < 8; maske++) {
    const kopie = feld.map(z => [...z]);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (!fest[y][x] && MASKEN[maske](x, y)) kopie[y][x] ^= 1;
      }
    }

    const f = formatBits(stufe, maske);
    for (let i = 0; i < 15; i++) {
      const bit = (f >> i) & 1;
      // Zweimal eingetragen, damit die Angabe auch dann lesbar bleibt, wenn
      // eine Ecke des Codes beschädigt ist.
      if (i < 6)       kopie[i][8] = bit;
      else if (i === 6) kopie[7][8] = bit;
      else if (i === 7) kopie[8][8] = bit;
      else if (i === 8) kopie[8][7] = bit;
      else              kopie[8][14 - i] = bit;

      if (i < 8) kopie[8][n - 1 - i] = bit;
      else       kopie[n - 15 + i][8] = bit;
    }

    if (version >= 7) {
      const v = versionBits(version);
      for (let i = 0; i < 18; i++) {
        const bit = (v >> i) & 1;
        kopie[Math.floor(i / 3)][i % 3 + n - 11] = bit;
        kopie[i % 3 + n - 11][Math.floor(i / 3)] = bit;
      }
    }

    const punkte = strafe(kopie, n);
    if (!beste || punkte < beste.punkte) beste = { punkte, feld: kopie, maske };
  }

  return { version, n, feld: beste.feld, maske: beste.maske, stufe };
}

// ── Als SVG ausgeben ────────────────────────────────────────────────────────

// Vier Module Rand ringsum. Ohne diese Ruhezone findet ein Lesegerät die
// Suchmuster nicht zuverlässig – das ist keine Kosmetik, sondern Teil der Norm.
const RUHE = 4;

function svg({ n, feld }, hell, dunkel) {
  const gesamt = n + RUHE * 2;

  // Jede dunkle Zeile als ein Pfad aus waagerechten Strecken: das ergibt
  // deutlich weniger Text als ein Rechteck je Modul.
  const teile = [];
  for (let y = 0; y < n; y++) {
    let x = 0;
    while (x < n) {
      if (feld[y][x] !== 1) { x++; continue; }
      let breite = 1;
      while (x + breite < n && feld[y][x + breite] === 1) breite++;
      teile.push(`M${x + RUHE} ${y + RUHE}h${breite}v1h-${breite}z`);
      x += breite;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${gesamt} ${gesamt}" `
    + `shape-rendering="crispEdges" role="img" aria-label="QR-Code">`
    + `<rect width="${gesamt}" height="${gesamt}" fill="${hell}"/>`
    + `<path fill="${dunkel}" d="${teile.join('')}"/>`
    + `</svg>\n`;
}

// ── Los ─────────────────────────────────────────────────────────────────────
//
// Nur beim direkten Aufruf. Wer die Datei importiert – etwa um den Code gegen
// einen echten Decoder zu prüfen – bekommt `bauen` und sonst nichts.

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const code = bauen(ZIEL, 'Q');

  // Dunkel auf hell, nicht umgekehrt: manche Lesegeräte kommen mit einem
  // umgekehrten Code nicht zurecht. Die Töne sind die der Seite, nur vertauscht.
  writeFileSync(DATEI, svg(code, '#f0ece3', '#0f0e0c'));

  console.log(`${ZIEL}`);
  console.log(`Version ${code.version} (${code.n}×${code.n}), Stufe ${code.stufe}, Maske ${code.maske}`);
  console.log('→ public/qr.svg');
}

export { bauen, svg };
