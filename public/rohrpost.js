// Die Rohrpost: eine kleine 3D-Anlage hinter den Glaskarten beider Seiten.
//
// Die Leinwand liegt fest hinter dem Inhalt. Eine Welteinheit ist genau ein
// CSS-Pixel des Dokuments (x nach rechts, y nach OBEN, also -scrollY), und die
// Kamera fährt beim Scrollen mit. Dadurch klebt die Station exakt an ihrem
// Platzhalter im Seitenfluss, und Dinge weiter hinten (z < 0) scrollen von
// selbst langsamer – Tiefe ohne einen Handgriff.
//
// Alles hier ist Dekoration. Scheitert irgendetwas – kein WebGL, alter Browser,
// „Bewegung reduzieren“ –, liefert starteRohrpost() null und die Seite
// funktioniert genauso, nur ohne Röhre.

import * as THREE from './vendor/three.module.min.js';

const FARBEN = [0xff6b5a, 0x3fc7a4, 0xffc63d, 0x4a90e2, 0xa78bfa, 0xff8fc7];
let farbZaehler = Math.floor(Math.random() * FARBEN.length);
const naechsteFarbe = () => FARBEN[farbZaehler++ % FARBEN.length];

const Y_ACHSE = new THREE.Vector3(0, 1, 0);
const Z_ACHSE = new THREE.Vector3(0, 0, 1);

const clamp01   = t => Math.min(1, Math.max(0, t));
const easeOut   = t => 1 - Math.pow(1 - clamp01(t), 3);
const easeIn    = t => Math.pow(clamp01(t), 3);
const easeInOut = t => { t = clamp01(t); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
const easeBack  = t => { t = clamp01(t); const c = 1.9; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
const zufall    = (a, b) => a + Math.random() * (b - a);

// Gedämpfte Feder – für alles, was nachwippen soll.
class Feder {
  constructor(wert = 0, haerte = 220, daempfung = 14) {
    this.x = wert; this.v = 0; this.ziel = wert;
    this.k = haerte; this.d = daempfung;
  }
  schritt(dt) {
    this.v += ((this.ziel - this.x) * this.k - this.v * this.d) * dt;
    this.x += this.v * dt;
    return this.x;
  }
}

// ── Werkstoffe ──────────────────────────────────────────────────────────────

const stoff = {
  messing: new THREE.MeshStandardMaterial({ color: 0xf0bd55, metalness: 1, roughness: 0.26 }),
  chrom:   new THREE.MeshStandardMaterial({ color: 0xe6edf5, metalness: 1, roughness: 0.14 }),
  gummi:   new THREE.MeshStandardMaterial({ color: 0x2b3150, roughness: 0.75 }),
  koralle: new THREE.MeshPhysicalMaterial({ color: 0xff6b5a, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.12 }),
  marine:  new THREE.MeshPhysicalMaterial({ color: 0x24457a, roughness: 0.4, clearcoat: 0.7, clearcoatRoughness: 0.2 }),
  weiss:   new THREE.MeshStandardMaterial({ color: 0xfbfaf4, roughness: 0.45 }),
  papier:  new THREE.MeshStandardMaterial({ color: 0xfffbea, roughness: 0.9 }),
  schlund: new THREE.MeshBasicMaterial({ color: 0x0f1c33 }),
  ventil:  new THREE.MeshPhysicalMaterial({ color: 0xe8453a, roughness: 0.3, clearcoat: 1 }),
};

// Glas als eigener Shader: fast durchsichtig in der Mitte, hell an den
// Rändern, dazu ein Glanzstreifen. Echte Lichtbrechung (transmission) wäre
// teurer und sähe bei einem so dünnen Rohr kaum anders aus.
function glas(seite, staerke = 1) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTon:     { value: new THREE.Color(0xc4ecff) },
      uRand:    { value: new THREE.Color(0x3d7fc4) },
      uStaerke: { value: staerke },
    },
    vertexShader: /* glsl */`
      varying vec3 vN;
      varying vec3 vBlick;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vBlick = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uTon;
      uniform vec3 uRand;
      uniform float uStaerke;
      varying vec3 vN;
      varying vec3 vBlick;
      void main() {
        vec3 n = normalize(vN);
        if (!gl_FrontFacing) n = -n;
        float rand  = pow(1.0 - abs(dot(n, vBlick)), 2.6);
        float glanz = pow(max(dot(n, normalize(vec3(-0.45, 0.75, 0.5))), 0.0), 36.0);
        float kante = pow(max(dot(n, normalize(vec3(0.6, -0.5, 0.6))), 0.0), 18.0) * 0.35;
        // Der Umriss wird blau statt weiß – vor hellem Himmel wäre eine weiße
        // Kante unsichtbar. Glanz und Gegenlicht bleiben weiß.
        float umriss = pow(1.0 - abs(dot(n, vBlick)), 5.0);
        float a = 0.12 + rand * 0.6 + umriss * 0.35 + glanz * 0.85 + kante;
        vec3 c = mix(uTon, uRand, clamp(umriss * 1.3, 0.0, 1.0));
        c = mix(c, vec3(1.0), clamp(glanz + kante, 0.0, 1.0));
        gl_FragColor = vec4(c, clamp(a, 0.0, 0.95) * uStaerke);
      }`,
    transparent: true,
    depthWrite: false,
    side: seite,
  });
}

// Eine Umgebung zum Spiegeln: Himmelsverlauf plus drei „Softboxen“. Ohne sie
// wären Messing und Chrom schlicht schwarz.
function baueUmgebung(renderer) {
  const s = new THREE.Scene();
  s.add(new THREE.Mesh(
    new THREE.SphereGeometry(100, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `varying vec3 vP; void main(){
        float h = vP.y;
        vec3 oben = vec3(0.35, 0.62, 1.0), mitte = vec3(1.0, 0.98, 0.95), unten = vec3(0.98, 0.78, 0.6);
        vec3 c = h > 0.0 ? mix(mitte, oben, pow(h, 0.55)) : mix(mitte, unten, pow(-h, 0.45));
        gl_FragColor = vec4(c, 1.0); }`,
    }),
  ));
  const box = (x, y, z, b, h, hell) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(b, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(hell, hell, hell), side: THREE.DoubleSide }));
    m.position.set(x, y, z);
    m.lookAt(0, 0, 0);
    s.add(m);
  };
  box(-45, 55, 55, 70, 34, 7);
  box(70, 15, 40, 22, 60, 3);
  box(0, -10, -85, 90, 18, 1.6);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const tex = pmrem.fromScene(s, 0.03).texture;
  pmrem.dispose();
  return tex;
}

// ── Formen, einmal gebaut und von allen Kapseln geteilt ─────────────────────

const form = {
  rumpf:    new THREE.CylinderGeometry(12, 12, 40, 32, 1, true),
  band:     new THREE.CylinderGeometry(12.35, 12.35, 7, 32, 1, true),
  ring:     new THREE.TorusGeometry(12.4, 2.3, 10, 32),
  boden:    new THREE.SphereGeometry(12, 28, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
  deckel:   new THREE.SphereGeometry(12, 28, 10, 0, Math.PI * 2, 0, Math.PI / 2),
  knauf:    new THREE.SphereGeometry(3.2, 16, 10),
  innen:    new THREE.CircleGeometry(11.6, 28),
  rolle:    new THREE.CylinderGeometry(6.5, 6.5, 30, 18),
  puff:     new THREE.IcosahedronGeometry(1, 1),
  schnipsel: new THREE.BoxGeometry(1, 1.6, 0.3),
};

// Eine Kapsel ist 1,25-mal so groß gebaut wie gezeichnet: so füllt sie das
// Rohr (Radius 19) fast aus, wie es sich für Rohrpost gehört.
function baueKapsel(farbe) {
  const aussen = new THREE.Group();
  const k = new THREE.Group();
  k.scale.setScalar(1.25);
  aussen.add(k);
  const lack = new THREE.MeshPhysicalMaterial({ color: farbe, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.08, side: THREE.DoubleSide });

  k.add(new THREE.Mesh(form.rumpf, lack));
  const band = new THREE.Mesh(form.band, stoff.weiss);
  band.position.y = -3;
  k.add(band);

  for (const y of [-14, 14]) {
    const r = new THREE.Mesh(form.ring, stoff.gummi);
    r.rotation.x = Math.PI / 2;
    r.position.y = y;
    k.add(r);
  }

  const boden = new THREE.Mesh(form.boden, stoff.chrom);
  boden.position.y = -20;
  boden.scale.y = 0.7;
  k.add(boden);

  // Innen dunkel, damit man bei offenem Deckel hineinschaut und nicht durch.
  const innen = new THREE.Mesh(form.innen, stoff.schlund);
  innen.rotation.x = -Math.PI / 2;
  innen.position.y = 8;
  k.add(innen);

  // Der Inhalt: eine kleine Papierrolle, die erst beim Befüllen auftaucht.
  const rolle = new THREE.Mesh(form.rolle, stoff.papier);
  rolle.position.y = 14;
  rolle.visible = false;
  k.add(rolle);

  // Deckel mit Scharnier an der Rückseite.
  const scharnier = new THREE.Group();
  scharnier.position.set(0, 20, -12);
  const deckel = new THREE.Group();
  deckel.position.z = 12;
  const kuppel = new THREE.Mesh(form.deckel, stoff.chrom);
  kuppel.scale.y = 0.7;
  const knauf = new THREE.Mesh(form.knauf, stoff.messing);
  knauf.position.y = 8.6;
  deckel.add(kuppel, knauf);
  scharnier.add(deckel);
  k.add(scharnier);

  aussen.userData = { scharnier, rolle, lack };
  return aussen;
}

function entsorgeKapsel(k) {
  k.removeFromParent();
  k.userData.lack.dispose();
}

// ── Station ─────────────────────────────────────────────────────────────────

const TRICHTER_Y = 26;

function baueStation(neigung) {
  const g = new THREE.Group();

  const sockel = new THREE.Mesh(new THREE.CylinderGeometry(56, 62, 16, 56), stoff.marine);
  sockel.position.y = -64;
  const sockelRing = new THREE.Mesh(new THREE.TorusGeometry(56.5, 2.6, 10, 56), stoff.messing);
  sockelRing.rotation.x = Math.PI / 2;
  sockelRing.position.y = -56;
  g.add(sockel, sockelRing);

  // Eigener Lack je Station: nach dem Freischalten wird er umlackiert.
  const lack = stoff.koralle.clone();
  const rumpf = new THREE.Mesh(new THREE.CylinderGeometry(34, 38, 74, 56), lack);
  rumpf.position.y = -19;
  g.add(rumpf);
  for (const [y, r] of [[12, 34.4], [-48, 37.6]]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 3, 10, 56), stoff.messing);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = y;
    g.add(ring);
  }

  // Nieten rundherum – kostet fast nichts und macht es zur Maschine.
  const niete = new THREE.SphereGeometry(2.1, 10, 8);
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    const n = new THREE.Mesh(niete, stoff.messing);
    n.position.set(Math.sin(a) * 35.2, 4, Math.cos(a) * 35.2);
    g.add(n);
  }

  const hals = new THREE.Mesh(new THREE.CylinderGeometry(20, 24, 12, 40), stoff.messing);
  hals.position.y = TRICHTER_Y - 6;
  g.add(hals);

  // Der Trichter kippt zur Kamera, damit man hineinsieht.
  const trichter = new THREE.Group();
  trichter.position.y = TRICHTER_Y;
  trichter.rotation.x = neigung;
  const profil = [];
  for (let i = 0; i <= 14; i++) {
    const t = i / 14;
    profil.push(new THREE.Vector2(20 + 19 * Math.pow(t, 2.2), t * 34));
  }
  const glocke = new THREE.Mesh(new THREE.LatheGeometry(profil, 48),
    new THREE.MeshStandardMaterial({ color: 0xf0bd55, metalness: 1, roughness: 0.26, side: THREE.DoubleSide }));
  const lippe = new THREE.Mesh(new THREE.TorusGeometry(39, 2.6, 10, 48), stoff.messing);
  lippe.rotation.x = Math.PI / 2;
  lippe.position.y = 34;
  const schlund = new THREE.Mesh(new THREE.CircleGeometry(20.5, 32), stoff.schlund);
  schlund.rotation.x = -Math.PI / 2;
  schlund.position.y = 1.5;
  trichter.add(glocke, lippe, schlund);
  g.add(trichter);

  // Manometer vorne: die Nadel zeigt den Fortschritt als „Druck“.
  const mano = new THREE.Group();
  mano.position.set(0, -24, 37.4);
  const blatt = new THREE.Mesh(new THREE.CircleGeometry(13, 36), stoff.weiss);
  const fassung = new THREE.Mesh(new THREE.TorusGeometry(13.4, 2.2, 10, 36), stoff.messing);
  const skala = new THREE.Mesh(new THREE.RingGeometry(9.5, 11, 36, 1, -0.6, Math.PI + 1.2),
    new THREE.MeshBasicMaterial({ color: 0x3fc7a4 }));
  skala.position.z = 0.3;
  const rot = new THREE.Mesh(new THREE.RingGeometry(9.5, 11, 12, 1, -0.6, 0.9),
    new THREE.MeshBasicMaterial({ color: 0xff6b5a }));
  rot.position.z = 0.35;
  const nadel = new THREE.Group();
  nadel.position.z = 0.8;
  const zeiger = new THREE.Mesh(new THREE.BoxGeometry(1.8, 10.5, 0.6), new THREE.MeshBasicMaterial({ color: 0x14213a }));
  zeiger.position.y = 4.6;
  const nabe = new THREE.Mesh(new THREE.CircleGeometry(2.2, 16), stoff.messing);
  nabe.position.z = 0.5;
  nadel.add(zeiger, nabe);
  mano.add(blatt, fassung, skala, rot, nadel);
  g.add(mano);

  // Signallampe auf einem Stängel links.
  const stiel = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 34, 12), stoff.chrom);
  stiel.position.set(-47, -41, 12);
  const lampenStoff = new THREE.MeshStandardMaterial({ color: 0xdfe6ee, emissive: 0x000000, roughness: 0.2 });
  const birne = new THREE.Mesh(new THREE.SphereGeometry(8, 24, 16), lampenStoff);
  birne.position.set(-47, -20, 12);
  const kappe = new THREE.Mesh(new THREE.CylinderGeometry(5, 6, 4, 16), stoff.messing);
  kappe.position.set(-47, -26, 12);
  const schein = new THREE.PointLight(0xffffff, 0, 140, 1.6);
  schein.position.copy(birne.position);
  g.add(stiel, birne, kappe, schein);

  g.userData = { trichter, nadel, lampenStoff, schein, rumpf, lack };
  return g;
}

// Weicher Bodenschatten als Bild – der Kamera zugewandt, leicht dahinter.
function baueSchatten() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 64;
  const x = c.getContext('2d');
  const v = x.createRadialGradient(64, 32, 0, 64, 32, 64);
  v.addColorStop(0, 'rgba(20,45,90,0.38)');
  v.addColorStop(1, 'rgba(20,45,90,0)');
  x.fillStyle = v;
  x.fillRect(0, 0, 128, 64);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(220, 60),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
  m.position.set(0, -74, -40);
  return m;
}

// Handrad für das Ventil der Abhol-Seite.
function baueVentil() {
  const g = new THREE.Group();
  const spindel = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 34, 12), stoff.chrom);
  spindel.rotation.x = Math.PI / 2;
  spindel.position.z = 14;
  const rad = new THREE.Group();
  rad.position.z = 32;
  rad.add(new THREE.Mesh(new THREE.TorusGeometry(17, 3.2, 12, 36), stoff.ventil));
  for (let i = 0; i < 4; i++) {
    const speiche = new THREE.Mesh(new THREE.BoxGeometry(3, 32, 2.4), stoff.ventil);
    speiche.rotation.z = (i / 4) * Math.PI;
    rad.add(speiche);
  }
  rad.add(new THREE.Mesh(new THREE.SphereGeometry(5, 16, 10), stoff.messing));
  const gehaeuse = new THREE.Mesh(new THREE.CylinderGeometry(24, 24, 22, 32), stoff.messing);
  gehaeuse.rotation.z = Math.PI / 2;
  g.add(gehaeuse, spindel, rad);
  g.userData = { rad };
  return g;
}

// ── Röhren ──────────────────────────────────────────────────────────────────

function baueRoehre(kurve, radius, segmente, staerke = 1, schellenAbstand = 170) {
  const g = new THREE.Group();
  const geo = new THREE.TubeGeometry(kurve, segmente, radius, 22, false);
  const hinten = new THREE.Mesh(geo, glas(THREE.BackSide, staerke));
  const vorne  = new THREE.Mesh(geo, glas(THREE.FrontSide, staerke));
  hinten.renderOrder = 1;
  vorne.renderOrder = 2;
  g.add(hinten, vorne);

  // Messingschellen in gleichen Abständen.
  const laenge = kurve.getLength();
  const anzahl = Math.max(2, Math.floor(laenge / schellenAbstand));
  const schelle = new THREE.TorusGeometry(radius + 1, 2.2, 8, 26);
  for (let i = 1; i < anzahl; i++) {
    const u = i / anzahl;
    const m = new THREE.Mesh(schelle, stoff.messing);
    m.position.copy(kurve.getPointAt(u));
    m.quaternion.setFromUnitVectors(Z_ACHSE, kurve.getTangentAt(u));
    g.add(m);
  }
  g.userData = { geo, schelle };
  return g;
}

function entsorgeRoehre(g) {
  g.removeFromParent();
  g.userData.geo.dispose();
  g.userData.schelle.dispose();
  g.children.forEach(c => c.material !== stoff.messing && c.material.dispose());
}

// Eine Wolke aus ein paar kantigen Kugeln – Spielzeug, nicht Wetterbericht.
function baueWolke(stoffWolke) {
  const g = new THREE.Group();
  const n = 4 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) {
    const r = zufall(28, 52);
    const m = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), stoffWolke);
    m.position.set((i - n / 2) * zufall(30, 42), Math.sin(i * 1.7) * 14 + (i % 2) * 10, zufall(-10, 10));
    g.add(m);
  }
  return g;
}

// ═══════════════════════════════════════════════════════════════════════════

export async function starteRohrpost({ modus = 'senden', station: platz, karte }) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return null;

  const leinwand = document.createElement('canvas');
  leinwand.className = 'rohr-leinwand';
  leinwand.setAttribute('aria-hidden', 'true');

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: leinwand, antialias: true, alpha: true, powerPreference: 'low-power' });
  } catch {
    return null;
  }
  document.body.prepend(leinwand);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.setClearColor(0x000000, 0);

  const nacht = matchMedia('(prefers-color-scheme: dark)');

  const szene = new THREE.Scene();
  szene.environment = baueUmgebung(renderer);
  szene.environmentIntensity = 0.9;

  const himmelLicht = new THREE.HemisphereLight(0xe2f2ff, 0xffe6c7, 0.9);
  const sonne = new THREE.DirectionalLight(0xfff1dc, 1.8);
  sonne.position.set(-500, 900, 800);
  szene.add(himmelLicht, sonne);

  const kamera = new THREE.PerspectiveCamera(30, 1, 10, 8000);
  const TAN_HALB = Math.tan(THREE.MathUtils.degToRad(15));
  let breite = 1, hoehe = 1, abstand = 1;

  // ── Station ──────────────────────────────────────────────────────────────

  const senden = modus === 'senden';
  const NEIGUNG = senden ? 0.5 : 0.62;
  const station = baueStation(NEIGUNG);
  station.rotation.y = senden ? -0.32 : 0.3;
  station.add(baueSchatten());
  szene.add(station);

  const { trichter, nadel, lampenStoff, schein, lack: stationsLack } = station.userData;
  const ACHSE = new THREE.Vector3(0, Math.cos(NEIGUNG), Math.sin(NEIGUNG));
  const MUND = new THREE.Vector3(0, TRICHTER_Y, 0).addScaledVector(ACHSE, 34);
  const amMund = d => MUND.clone().addScaledVector(ACHSE, d);

  let ventil = null;
  if (!senden) {
    ventil = baueVentil();
    szene.add(ventil);
  }

  let massstab = 1;
  let stationBodenY = 0;
  let roehre = null;
  let kurve = null;
  let bodenY = 0;

  // ── Hintergrund: weitere Leitungen und Wolken, weit hinten ───────────────

  const hintergrund = new THREE.Group();
  szene.add(hintergrund);
  const nebenLeitungen = [];
  const wolken = [];
  const wolkenStoff = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true, emissive: 0xc9e2ff, emissiveIntensity: 0.25 });
  let sterne = null;
  let hintergrundBreite = 0;

  function baueHintergrund() {
    for (const l of nebenLeitungen) entsorgeRoehre(l.gruppe);
    nebenLeitungen.length = 0;
    for (const w of wolken) w.removeFromParent();
    wolken.length = 0;

    const mitte = breite / 2;
    const spanne = breite * 1.6 + 800;
    const ebenen = [
      { z: -520,  y: 0.2,  welle: 60, phase: 0.3 },
      { z: -1050, y: 0.72, welle: 90, phase: 2.1 },
    ];
    for (const e of ebenen) {
      const punkte = [];
      for (let i = 0; i <= 8; i++) {
        const t = i / 8;
        punkte.push(new THREE.Vector3(
          mitte - spanne / 2 + spanne * t,
          -hoehe * e.y + Math.sin(t * 5 + e.phase) * e.welle,
          e.z + Math.cos(t * 4 + e.phase) * 60,
        ));
      }
      const k = new THREE.CatmullRomCurve3(punkte, false, 'centripetal');
      const gruppe = baueRoehre(k, 22, 160, 1.3, 520);
      hintergrund.add(gruppe);
      nebenLeitungen.push({ kurve: k, laenge: k.getLength(), gruppe, naechste: zufall(0.5, 3), faehrt: [] });
    }

    for (let i = 0; i < 7; i++) {
      const w = baueWolke(wolkenStoff);
      w.position.set(zufall(-breite, breite * 2), -hoehe * zufall(0.05, 0.6), zufall(-2200, -1400));
      w.scale.setScalar(zufall(0.8, 1.5));
      w.userData.tempo = zufall(6, 16);
      hintergrund.add(w);
      wolken.push(w);
    }
    hintergrundBreite = breite;
  }

  function baueSterne() {
    const n = 260;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3]     = zufall(-breite * 1.5, breite * 2.5);
      pos[i * 3 + 1] = -zufall(-hoehe, hoehe * 2);
      pos[i * 3 + 2] = zufall(-3200, -2600);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    // Runde Sterne statt der eckigen Standardpunkte.
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const x = c.getContext('2d');
    const v = x.createRadialGradient(16, 16, 0, 16, 16, 16);
    v.addColorStop(0, 'rgba(255,255,255,1)');
    v.addColorStop(0.35, 'rgba(255,255,255,0.8)');
    v.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = v;
    x.fillRect(0, 0, 32, 32);
    return new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0xffffff, size: 5, sizeAttenuation: false, transparent: true, opacity: 0.9,
      map: new THREE.CanvasTexture(c), depthWrite: false,
    }));
  }

  function tageszeit() {
    const dunkel = nacht.matches;
    himmelLicht.intensity = dunkel ? 0.45 : 0.9;
    sonne.intensity = dunkel ? 0.9 : 1.8;
    sonne.color.set(dunkel ? 0xbcd2ff : 0xfff1dc);
    szene.environmentIntensity = dunkel ? 0.55 : 0.9;
    wolkenStoff.color.set(dunkel ? 0x4a5f94 : 0xffffff);
    wolkenStoff.emissive.set(dunkel ? 0x1a2750 : 0xc9e2ff);
    wolkenStoff.transparent = dunkel;
    wolkenStoff.opacity = dunkel ? 0.35 : 1;
    wolkenStoff.depthWrite = !dunkel;
    wolkenStoff.needsUpdate = true;
    if (dunkel && !sterne) { sterne = baueSterne(); hintergrund.add(sterne); }
    if (sterne) sterne.visible = dunkel;
  }
  nacht.addEventListener?.('change', tageszeit);

  // ── Vermessen: Leinwand, Station und Hauptleitung an die Seite anpassen ──

  function dokRechteck(el) {
    const r = el.getBoundingClientRect();
    return { links: r.left + scrollX, oben: r.top + scrollY, rechts: r.right + scrollX, unten: r.bottom + scrollY, b: r.width, h: r.height };
  }

  function vermessen() {
    breite = leinwand.clientWidth || innerWidth;
    hoehe  = leinwand.clientHeight || innerHeight;
    renderer.setSize(breite, hoehe, false);
    kamera.aspect = breite / hoehe;
    abstand = (hoehe / 2) / TAN_HALB;
    kamera.far = abstand + 4000;
    kamera.updateProjectionMatrix();

    if (Math.abs(hintergrundBreite - breite) > 40) { baueHintergrund(); tageszeit(); }

    const p = dokRechteck(platz);
    const k = dokRechteck(karte || platz);
    // Die Station steht unten auf ihrem Platz; darüber bleibt Luft für die
    // Kapsel, die aus dem Trichter steigt.
    massstab = Math.min(1.1, Math.max(0.65, p.h / 200));
    station.scale.setScalar(massstab);
    stationBodenY = -p.unten + 4 * massstab;
    station.position.set(p.links + p.b / 2, stationBodenY + 72 * massstab, 0);
    station.userData.mitteX = station.position.x;
    station.updateMatrixWorld(true);

    const seitenBreite = document.documentElement.clientWidth;
    const rechts = Math.min(k.rechts + 90, seitenBreite - 30);
    const S = station.position;
    const r = 19 * massstab;
    const pkt = (x, y, z) => new THREE.Vector3(x, y, z);
    const lokal = (x, y, z) => station.localToWorld(new THREE.Vector3(x, y, z));
    const R = 58;
    const punkte = [];

    if (senden) {
      // Aus dem Bauch nach rechts, am Rand hoch, eine Schleife neben der
      // Karte und oben rechts aus dem Bild.
      const schleifeY = -(k.oben + k.h * 0.42);
      punkte.push(lokal(0, -14, 0), lokal(58, -14, 0), lokal(96, -14, 0));
      punkte.push(pkt(rechts - 24, S.y - 14 * massstab, -8));
      punkte.push(pkt(rechts, S.y + 50, -10));
      if (schleifeY - R * 1.6 > S.y + 50) punkte.push(pkt(rechts, (S.y + 50 + schleifeY - R) / 2, -10));
      for (let i = 0; i <= 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        punkte.push(pkt(rechts - R + R * Math.cos(a), schleifeY + R * Math.sin(a), -10 + 56 * (i / 10)));
      }
      const kopfY = -(k.oben - 30);
      punkte.push(pkt(rechts, Math.max(schleifeY + R * 1.4, (schleifeY + kopfY) / 2), 46));
      punkte.push(pkt(rechts + 20, kopfY + 40, 30));
      punkte.push(pkt(rechts + 120, kopfY + 90, 10));
      punkte.push(pkt(seitenBreite + 400, kopfY + 120, 0));
    } else {
      // Von rechts herein und seitlich in den Bauch der Station. Die Schleife
      // gibt es nur, wenn rechts neben dem Inhalt Platz ist – auf dem Handy
      // läge sie sonst quer über dem Untertitel.
      const platz = seitenBreite - k.rechts > 170;
      if (platz) {
        const schleifeY = S.y + 150;
        punkte.push(pkt(seitenBreite + 400, S.y + 360, 0));
        punkte.push(pkt(rechts + 110, S.y + 320, 10));
        punkte.push(pkt(rechts, schleifeY + R * 1.5, -10));
        for (let i = 0; i <= 10; i++) {
          const a = -(i / 10) * Math.PI * 2;
          punkte.push(pkt(rechts - R + R * Math.cos(a), schleifeY + R * Math.sin(a), -10 + 56 * (i / 10)));
        }
        punkte.push(pkt(rechts, S.y + 40, 30));
      } else {
        punkte.push(pkt(seitenBreite + 400, S.y + 70, 0));
        punkte.push(pkt(seitenBreite + 20, S.y + 56, 0));
        punkte.push(pkt(rechts, S.y + 30, -4));
      }
      punkte.push(pkt(rechts - 40, S.y - 14 * massstab, -8));
      punkte.push(lokal(96, -14, 0), lokal(58, -14, 0), lokal(0, -14, 0));
    }

    kurve = new THREE.CatmullRomCurve3(punkte, false, 'centripetal', 0.5);
    if (roehre) entsorgeRoehre(roehre);
    roehre = baueRoehre(kurve, r, Math.min(600, Math.round(kurve.getLength() / 6)));
    szene.add(roehre);

    if (ventil) {
      const vx = (S.x + rechts) / 2 + 20;
      ventil.position.set(Math.max(vx, S.x + 110 * massstab), S.y - 14 * massstab, 0);
      ventil.scale.setScalar(massstab);
    }

    bodenY = S.y - 72 * massstab;
  }

  let schmutzig = true;
  const neuVermessen = () => { schmutzig = true; };
  new ResizeObserver(neuVermessen).observe(document.body);
  new ResizeObserver(neuVermessen).observe(platz);
  if (karte) new ResizeObserver(neuVermessen).observe(karte);
  addEventListener('resize', neuVermessen);
  document.fonts?.ready.then(neuVermessen);

  // Leichte Neigung des Hintergrunds zum Zeiger – nur hinten, damit die
  // Station genau auf ihrem Platz bleibt.
  const zeiger = { x: 0, y: 0, zx: 0, zy: 0 };
  addEventListener('pointermove', e => {
    zeiger.zx = (e.clientX / breite - 0.5) * 2;
    zeiger.zy = (e.clientY / hoehe - 0.5) * 2;
  }, { passive: true });

  function kameraNachfuehren() {
    const cx = scrollX + breite / 2;
    const cy = -(scrollY + hoehe / 2);
    kamera.position.set(cx, cy, abstand);
    kamera.lookAt(cx, cy, 0);
    kamera.updateMatrixWorld();
  }

  function aufBildschirm(welt) {
    const v = welt.clone().project(kamera);
    return { x: (v.x + 1) / 2 * breite, y: (1 - v.y) / 2 * hoehe };
  }

  // ── Kleinzeug: Dampfwölkchen und Konfetti ────────────────────────────────

  const teilchen = [];
  const puffStoff = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, transparent: true, depthWrite: false });

  function puff(welt, anzahl = 10, grau = false, richtung = null) {
    for (let i = 0; i < anzahl; i++) {
      const m = new THREE.Mesh(form.puff, grau ? puffStoff.clone() : puffStoff);
      if (grau) m.material.color.set(0x9aa7bb);
      m.position.copy(welt);
      const v = new THREE.Vector3(zufall(-1, 1), zufall(-0.3, 1), zufall(-0.5, 1)).normalize().multiplyScalar(zufall(60, 170));
      if (richtung) v.addScaledVector(richtung, 140);
      szene.add(m);
      teilchen.push({ m, v, alter: 0, dauer: zufall(0.5, 0.9), groesse: zufall(7, 14) * massstab, art: 'puff' });
    }
  }

  function konfetti(welt, anzahl = 36, farben = FARBEN) {
    for (let i = 0; i < anzahl; i++) {
      const m = new THREE.Mesh(form.schnipsel, new THREE.MeshStandardMaterial({ color: farben[i % farben.length], roughness: 0.4, metalness: farben === FARBEN ? 0 : 0.6, side: THREE.DoubleSide }));
      m.position.copy(welt);
      m.scale.setScalar(zufall(4, 7) * massstab);
      const v = new THREE.Vector3(zufall(-1, 1), zufall(0.9, 2.2), zufall(-0.4, 1)).normalize().multiplyScalar(zufall(320, 620));
      szene.add(m);
      teilchen.push({ m, v, dreh: new THREE.Vector3(zufall(-9, 9), zufall(-9, 9), zufall(-9, 9)), alter: 0, dauer: zufall(1.3, 2), art: 'konfetti' });
    }
  }

  function teilchenTick(dt) {
    for (let i = teilchen.length - 1; i >= 0; i--) {
      const t = teilchen[i];
      t.alter += dt;
      const u = t.alter / t.dauer;
      if (u >= 1) {
        t.m.removeFromParent();
        if (t.m.material !== puffStoff) t.m.material.dispose();
        teilchen.splice(i, 1);
        continue;
      }
      t.m.position.addScaledVector(t.v, dt);
      if (t.art === 'puff') {
        t.v.multiplyScalar(1 - 2.5 * dt);
        t.m.scale.setScalar(t.groesse * (0.4 + easeOut(u) * 1.1));
        if (t.m.material !== puffStoff) t.m.material.opacity = 1 - u;
        else t.m.scale.multiplyScalar(1 - u * 0.9);
      } else {
        t.v.y -= 900 * dt;
        t.v.multiplyScalar(1 - 1.4 * dt);
        t.m.rotation.x += t.dreh.x * dt;
        t.m.rotation.y += t.dreh.y * dt;
        t.m.rotation.z += t.dreh.z * dt;
        if (u > 0.75) t.m.scale.multiplyScalar(1 - (u - 0.75) * 0.25);
      }
    }
  }

  // ── Fliegende Kapseln ────────────────────────────────────────────────────

  const flieger = [];     // in der Hauptleitung
  const wuerfe = [];      // frei fallend (zurückgespuckt oder angekommen)

  function losschicken(kapsel, { kurve: k, v = 300, a = 4200, vmax = 2800, danach = null }) {
    kapsel.scale.setScalar(massstab);
    szene.add(kapsel);
    flieger.push({ kapsel, kurve: k, laenge: k.getLength(), s: 0, v, a, vmax, danach, dreh: zufall(-4, 4) });
  }

  const tangente = new THREE.Vector3();
  const drehung = new THREE.Quaternion();

  function fliegerTick(dt) {
    for (let i = flieger.length - 1; i >= 0; i--) {
      const f = flieger[i];
      f.v = Math.min(f.vmax, f.v + f.a * dt);
      f.s += f.v * dt;
      if (f.s >= f.laenge) {
        flieger.splice(i, 1);
        if (f.danach) f.danach(f.kapsel);
        else entsorgeKapsel(f.kapsel);
        continue;
      }
      const u = f.s / f.laenge;
      f.kurve.getPointAt(u, f.kapsel.position);
      f.kurve.getTangentAt(u, tangente);
      f.kapsel.quaternion.setFromUnitVectors(Y_ACHSE, tangente);
      drehung.setFromAxisAngle(Y_ACHSE, f.s * 0.01 * f.dreh);
      f.kapsel.quaternion.multiply(drehung);
      const zug = Math.min(0.4, f.v / 7000);
      f.kapsel.scale.set(massstab * (1 - zug * 0.4), massstab * (1 + zug), massstab * (1 - zug * 0.4));
    }

    for (const l of nebenLeitungen) {
      l.naechste -= dt;
      if (l.naechste <= 0) {
        l.naechste = zufall(2.5, 7);
        const k = baueKapsel(naechsteFarbe());
        const rueckwaerts = Math.random() < 0.5;
        hintergrund.add(k);
        l.faehrt.push({ k, s: 0, v: zufall(700, 1300), rueckwaerts });
      }
      for (let i = l.faehrt.length - 1; i >= 0; i--) {
        const f = l.faehrt[i];
        f.s += f.v * dt;
        if (f.s >= l.laenge) { entsorgeKapsel(f.k); l.faehrt.splice(i, 1); continue; }
        const u = f.rueckwaerts ? 1 - f.s / l.laenge : f.s / l.laenge;
        l.kurve.getPointAt(u, f.k.position);
        l.kurve.getTangentAt(u, tangente);
        f.k.quaternion.setFromUnitVectors(Y_ACHSE, tangente);
      }
    }
  }

  // Ballistisch: für zurückgespuckte Kapseln (Fehler) und für angekommene,
  // die auf dem Boden landen, einmal hüpfen und dann aufplatzen.
  function wurfTick(dt) {
    const unten = kamera.position.y - hoehe;
    for (let i = wuerfe.length - 1; i >= 0; i--) {
      const w = wuerfe[i];
      w.alter += dt;
      const k = w.kapsel;

      if (w.liegt) {
        w.liegt += dt;
        k.rotation.z += (w.zielKipp - k.rotation.z) * Math.min(1, dt * 10);
        k.position.x += w.v.x * dt;
        w.v.x *= 1 - 5 * dt;
        if (w.liegt > 0.55 && !w.offen) {
          w.offen = true;
          const welt = k.getWorldPosition(new THREE.Vector3());
          konfetti(welt, 18);
          puff(welt, 6);
        }
        if (w.offen) {
          k.userData.scharnier.rotation.x = Math.max(-2.3, k.userData.scharnier.rotation.x - dt * 14);
          const u = (w.liegt - 0.55) / 0.35;
          k.scale.setScalar(massstab * (1 + 0.25 * Math.sin(u * Math.PI)) * (1 - easeIn(u)));
          if (u >= 1) { entsorgeKapsel(k); wuerfe.splice(i, 1); }
        }
        continue;
      }

      w.v.y -= 1900 * dt;
      k.position.addScaledVector(w.v, dt);
      k.rotation.x += w.dreh.x * dt;
      k.rotation.z += w.dreh.z * dt;

      if (w.boden !== undefined && k.position.y <= w.boden && w.v.y < 0) {
        k.position.y = w.boden;
        w.huepfer = (w.huepfer || 0) + 1;
        puff(k.position, 3);
        if (w.huepfer >= 2 || Math.abs(w.v.y) < 260) {
          w.liegt = 0.0001;
          w.v.y = 0;
          k.rotation.x = 0;
          k.rotation.y = 0;
          w.zielKipp = w.v.x > 0 ? -Math.PI / 2 : Math.PI / 2;
        } else {
          w.v.y *= -0.38;
          w.v.x *= 0.6;
          w.dreh.multiplyScalar(0.5);
        }
      }

      if (w.boden === undefined && (k.position.y < unten - 200 || w.alter > 4)) {
        entsorgeKapsel(k);
        wuerfe.splice(i, 1);
      }
    }
  }

  // ── Lampe, Manometer, Wippen ─────────────────────────────────────────────

  const LAMPE = {
    aus:     [0xdfe6ee, 0x000000, 0],
    arbeit:  [0xffd45c, 0xffb400, 1.6],
    gut:     [0x7ff0c4, 0x19c98f, 2.2],
    fehler:  [0xff8a7a, 0xff2d1a, 2.2],
    hunger:  [0x9fd0ff, 0x2f8cff, 1.8],
    zu:      [0xff8a7a, 0xd9261a, 1.1],
    offen:   [0x9ff5d2, 0x19c98f, 0.9],
    turbo:   [0xffe7a3, 0xffb400, 0.8],
  };
  let lampenBlitz = null;        // { art, bis }
  let hunger = false;
  let bereitGewuenscht = false;
  let ventilOffen = false;
  let uhr = 0;

  const druck = new Feder(0, 90, 11);
  const wippe = new Feder(0, 260, 9);
  const trichterWippe = new Feder(0, 300, 10);

  function lampenTick() {
    let art = senden ? (turboAn ? 'turbo' : 'aus') : (ventilOffen ? 'offen' : 'zu');
    let blinken = false;
    if (senden && (slot?.sendung || warteschlange.length)) { art = 'arbeit'; blinken = true; }
    if (hunger) { art = 'hunger'; blinken = true; }
    if (lampenBlitz && uhr < lampenBlitz.bis) { art = lampenBlitz.art; blinken = true; }
    const [farbe, glut, staerke] = LAMPE[art];
    const an = blinken ? 0.55 + 0.45 * Math.sin(uhr * 12) : 1;
    lampenStoff.color.set(farbe);
    lampenStoff.emissive.set(glut);
    lampenStoff.emissiveIntensity = staerke * an;
    schein.color.set(glut);
    schein.intensity = staerke * an * 2500 * massstab;

    // Beim Aufladen des Turbos läuft die Lampe einmal durch den Regenbogen.
    if (turbo?.phase === 'laden') {
      lampenStoff.emissive.setHSL((uhr * 1.6) % 1, 1, 0.55);
      lampenStoff.emissiveIntensity = 2.4;
      schein.color.copy(lampenStoff.emissive);
      schein.intensity = 5000 * massstab;
    }
  }

  function stationTick(dt) {
    uhr += dt;
    // Das Manometer wackelt ein wenig – Druckleitungen sind nie ganz ruhig.
    druck.ziel = slot?.sendung ? 0.08 + slot.sendung.p * 0.92 : 0;
    druck.schritt(dt);
    if (turbo?.phase === 'laden') druck.ziel = 1.08;
    nadel.rotation.z = 2.2 - druck.x * 4.4 + Math.sin(uhr * 31) * 0.02 * (slot?.sendung || turbo ? 1 : 0);

    wippe.schritt(dt);
    trichterWippe.ziel = hunger ? 0.08 + Math.sin(uhr * 9) * 0.05 : 0;
    trichterWippe.schritt(dt);

    // Gestaucht wird von unten: der Sockel bleibt auf dem Boden stehen.
    const s = massstab;
    const sy = s * (1 + wippe.x);
    station.scale.set(s * (1 - wippe.x * 0.5), sy, s * (1 - wippe.x * 0.5));
    station.position.y = stationBodenY + 72 * sy;
    trichter.scale.setScalar(1 + trichterWippe.x);
    station.rotation.y = (senden ? -0.32 : 0.3) + Math.sin(uhr * 0.7) * 0.035;

    if (ventil) {
      const rad = ventil.userData.rad;
      rad.rotation.z += ((ventil.userData.ziel ?? 0) - rad.rotation.z) * Math.min(1, dt * 3.2);
    }

    turboTick(dt);
    lampenTick();
    if (senden) sendeTick(dt);
    else empfangsTick(dt);
  }

  // ── Turbo: was nach dem Freischalten des großen Limits passiert ────────
  //
  // Die Nadel schlägt bis zum Anschlag aus, die Station zittert und dampft,
  // die Lampe läuft durch alle Farben – dann ein goldener Knall: die Station
  // ist umlackiert, ein Lichtring jagt durch die ganze Röhre, und drei
  // Sterne kreisen fortan um sie herum.

  const LACK_NORMAL = new THREE.Color(0xff6b5a);
  const LACK_TURBO  = new THREE.Color(0x7c4dff);
  const GOLD        = new THREE.Color(0xffc63d);
  const GLAS_TON    = new THREE.Color(0xc4ecff);
  const GOLDFARBEN  = [0xffc63d, 0xffe08a, 0xf0a818, 0xfff3c4, 0x7c4dff];

  let turboAn = false;
  let turbo = null;               // laufende Animation: { t, phase }
  let glasGlut = 0;               // 0 … 1: wie golden die Röhre gerade leuchtet
  const turboSterne = [];
  const lichtRinge = [];

  const sternForm = (() => {
    const f = new THREE.Shape();
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + Math.PI / 2;
      const r = i % 2 ? 3.2 : 7.5;
      f[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r, Math.sin(a) * r);
    }
    const g = new THREE.ExtrudeGeometry(f, { depth: 2.4, bevelEnabled: true, bevelSize: 0.9, bevelThickness: 0.9, bevelSegments: 2 });
    g.center();
    return g;
  })();
  const sternStoff = new THREE.MeshStandardMaterial({ color: 0xffd257, metalness: 0.7, roughness: 0.25, emissive: 0xffa800, emissiveIntensity: 0.45 });

  function sterneSetzen(an) {
    for (const st of turboSterne) st.removeFromParent();
    turboSterne.length = 0;
    if (!an) return;
    for (let i = 0; i < 3; i++) {
      const st = new THREE.Mesh(sternForm, sternStoff);
      st.userData.versatz = (i / 3) * Math.PI * 2;
      st.scale.setScalar(0.001);
      station.add(st);
      turboSterne.push(st);
    }
  }

  function lichtRing(verzoegerung, staerke) {
    const m = new THREE.Mesh(
      new THREE.TorusGeometry(24, 4.5, 12, 40),
      new THREE.MeshBasicMaterial({ color: 0xffd257, transparent: true, opacity: staerke, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    m.visible = false;
    szene.add(m);
    lichtRinge.push({ m, t: -verzoegerung, staerke });
  }

  function turboTick(dt) {
    // Die Sterne kreisen auch nach der Animation weiter.
    for (const st of turboSterne) {
      const a = uhr * 0.9 + st.userData.versatz;
      st.position.set(Math.cos(a) * 64, -8 + Math.sin(uhr * 1.4 + st.userData.versatz) * 16, Math.sin(a) * 64);
      st.rotation.set(0.3, uhr * 2.2 + st.userData.versatz, 0);
      const ziel = 1;
      st.scale.setScalar(st.scale.x + (ziel - st.scale.x) * Math.min(1, dt * 6));
    }

    for (let i = lichtRinge.length - 1; i >= 0; i--) {
      const r = lichtRinge[i];
      r.t += dt;
      if (r.t < 0) continue;
      const u = easeInOut(r.t / 1.3);
      if (u >= 1) { r.m.removeFromParent(); r.m.geometry.dispose(); r.m.material.dispose(); lichtRinge.splice(i, 1); continue; }
      r.m.visible = true;
      kurve.getPointAt(u, r.m.position);
      r.m.quaternion.setFromUnitVectors(Z_ACHSE, kurve.getTangentAt(u, tangente));
      r.m.scale.setScalar(massstab * (0.9 + Math.sin(r.t * 30) * 0.08));
      r.m.material.opacity = r.staerke * Math.min(1, (1 - u) * 4);
    }

    glasGlut = Math.max(0, glasGlut - dt * 0.7);
    if (roehre) {
      for (const teil of roehre.children) {
        teil.material.uniforms?.uTon.value.copy(GLAS_TON).lerp(GOLD, glasGlut);
      }
    }

    if (!turbo) return;
    turbo.t += dt;
    const t = turbo.t;

    if (turbo.phase === 'laden') {
      // Zittern, das immer stärker wird, und Dampf aus den Seiten.
      const u = t / 1.1;
      station.position.x = station.userData.mitteX + Math.sin(t * 70) * 3 * u * massstab;
      trichterWippe.v += Math.sin(t * 50) * 30 * u * dt;
      turbo.dampf = (turbo.dampf ?? 0) - dt;
      if (turbo.dampf <= 0) {
        turbo.dampf = 0.12;
        const seite = Math.random() < 0.5 ? -1 : 1;
        puff(station.localToWorld(new THREE.Vector3(seite * 38, zufall(-40, 0), 10)), 2, false,
          new THREE.Vector3(seite, 0.4, 0));
      }
      if (u >= 1) {
        turbo.phase = 'knall';
        turbo.t = 0;
        station.position.x = station.userData.mitteX;
        const mund = station.localToWorld(amMund(10));
        puff(mund, 22);
        konfetti(mund, 60, GOLDFARBEN);
        konfetti(station.localToWorld(new THREE.Vector3(0, -20, 30)), 30, GOLDFARBEN);
        wippe.v -= 3.4;
        trichterWippe.v += 7;
        glasGlut = 1;
        sterneSetzen(true);
        lichtRing(0, 1);
        lichtRing(0.07, 0.6);
        lichtRing(0.14, 0.35);
        lampenBlitz = { art: 'turbo', bis: uhr + 2 };
      }
    } else if (turbo.phase === 'knall') {
      // Umlackieren mit einem goldenen Aufblitzen.
      const u = t / 0.7;
      stationsLack.color.copy(LACK_NORMAL).lerp(LACK_TURBO, easeOut(u));
      stationsLack.emissive.copy(GOLD);
      stationsLack.emissiveIntensity = Math.max(0, 1 - u) * 0.9;
      if (u >= 1) {
        stationsLack.emissiveIntensity = 0;
        turbo = null;
      }
    }
  }

  function turboSchalten(an, sofort) {
    if (an === turboAn) return;
    turboAn = an;
    if (!an) {
      turbo = null;
      stationsLack.color.copy(LACK_NORMAL);
      stationsLack.emissiveIntensity = 0;
      sterneSetzen(false);
      return;
    }
    if (sofort) {
      stationsLack.color.copy(LACK_TURBO);
      sterneSetzen(true);
      for (const st of turboSterne) st.scale.setScalar(1);
      return;
    }
    turbo = { t: 0, phase: 'laden' };
  }

  // ── Senden: Kapsel anbieten, befüllen, verschließen, abschießen ──────────

  const warteschlange = [];
  let slot = null;

  function fliegeEin(sendung, dauer) {
    const ziel = aufBildschirm(station.localToWorld(amMund(44)));
    let r, klon;

    if (sendung.zettel) {
      r = sendung.zettel.rechteck;
      klon = document.createElement('div');
      klon.className = 'flug-zettel';
      klon.textContent = sendung.zettel.text;
    } else if (sendung.vorlage) {
      // Steht die Kachel noch da, fliegt sie von dort los. Sonst – der Upload
      // war schneller als die Animation und die Liste ist schon neu gezeichnet –
      // von dort, wo sie beim Einreihen stand.
      const q = sendung.quelle?.isConnected ? sendung.quelle.getBoundingClientRect() : null;
      r = q?.width ? { left: q.left, top: q.top, width: q.width, height: q.height } : sendung.vorlage.rechteck;
      klon = sendung.vorlage.klon;
      if (sendung.quelle?.isConnected) sendung.quelle.style.visibility = 'hidden';
    } else {
      return;
    }

    Object.assign(klon.style, {
      position: 'fixed', left: r.left + 'px', top: r.top + 'px',
      width: r.width + 'px', height: r.height + 'px', margin: '0',
      zIndex: '60', pointerEvents: 'none',
    });
    document.body.appendChild(klon);
    const dx = ziel.x - (r.left + r.width / 2);
    const dy = ziel.y - (r.top + r.height / 2);
    const hub = Math.min(160, 60 + Math.abs(dy) * 0.3);
    klon.animate([
      { transform: 'translate(0,0) scale(1) rotate(0deg)', opacity: 1 },
      { transform: `translate(${dx * 0.45}px, ${dy * 0.45 - hub}px) scale(0.72) rotate(-10deg)`, opacity: 1, offset: 0.45 },
      { transform: `translate(${dx}px, ${dy}px) scale(0.06) rotate(18deg)`, opacity: 0.5 },
    ], { duration: dauer * 1000, easing: 'cubic-bezier(.45,0,.55,1)', fill: 'forwards' })
      .finished.then(() => klon.remove(), () => klon.remove());
  }

  function slotPosition(pos) {
    slot.kapsel.position.copy(pos);
  }

  function neuerSlot(sendung) {
    const kapsel = baueKapsel(sendung?.farbe ?? naechsteFarbe());
    kapsel.rotation.x = NEIGUNG;
    kapsel.scale.setScalar(0.001);
    station.add(kapsel);
    return { kapsel, phase: 'hoch', t: 0, sendung: null };
  }

  function nimmSendung() {
    const i = warteschlange.findIndex(x => x.typ === 'sendung');
    if (i !== 0) return false;
    slot.sendung = warteschlange.shift();
    slot.phase = 'fuellen';
    slot.t = 0;
    return true;
  }

  function sendeTick(dt) {
    const tempo = Math.min(4, 1 + warteschlange.length * 0.6);

    if (!slot) {
      if (warteschlange[0]?.typ === 'jubel') {
        warteschlange.shift();
        jubeln();
        return;
      }
      if (warteschlange.length || bereitGewuenscht) slot = neuerSlot(warteschlange[0]);
      else return;
    }

    const k = slot.kapsel;
    const deckel = k.userData.scharnier;
    slot.t += dt * (slot.phase === 'warten' ? 1 : tempo);
    const t = slot.t;

    switch (slot.phase) {
      case 'hoch': {
        // Die Maschine bietet eine leere Kapsel an: sie steigt aus dem Trichter.
        const u = t / 0.55;
        slotPosition(amMund(-36 + 62 * easeBack(u)));
        k.scale.setScalar(0.5 + 0.5 * easeOut(u * 1.6));
        deckel.rotation.x = -2.25 * easeOut((u - 0.35) / 0.65);
        k.rotation.y = (1 - easeOut(u)) * 3;
        if (u >= 1) {
          trichterWippe.v += 3;
          if (!nimmSendung()) { slot.phase = 'bereit'; slot.t = 0; }
        }
        break;
      }
      case 'bereit': {
        slotPosition(amMund(26 + Math.sin(t * 2.6) * 4));
        k.rotation.y = Math.sin(t * 1.3) * 0.5;
        if (nimmSendung()) break;
        if (!bereitGewuenscht) { slot.phase = 'runter'; slot.t = 0; }
        break;
      }
      case 'runter': {
        const u = t / 0.4;
        slotPosition(amMund(26 - 70 * easeIn(u)));
        deckel.rotation.x = -2.25 * (1 - easeOut(u * 2));
        if (u >= 1) { entsorgeKapsel(k); slot = null; }
        break;
      }
      case 'fuellen': {
        const flug = 0.7;
        if (!slot.geflogen) { slot.geflogen = true; fliegeEin(slot.sendung, flug / tempo); }
        slotPosition(amMund(26 + Math.sin(t * 2.6) * 2));
        k.rotation.y *= 1 - dt * 6;
        if (t >= flug) {
          k.userData.rolle.visible = true;
          k.userData.rolle.scale.set(1, 0.01, 1);
          slot.phase = 'zu'; slot.t = 0;
        }
        break;
      }
      case 'zu': {
        const u = t / 0.38;
        k.userData.rolle.scale.y = Math.min(1, easeBack(u * 1.5));
        deckel.rotation.x = -2.25 * (1 - easeBack((u - 0.3) / 0.7));
        if (u >= 1) { deckel.rotation.x = 0; slot.phase = 'rein'; slot.t = 0; }
        break;
      }
      case 'rein': {
        const u = t / 0.42;
        slotPosition(amMund(26 - 16 * easeInOut(u)));
        k.rotation.y = easeInOut(u) * Math.PI * 2;
        if (u >= 1) { trichterWippe.v += 2; slot.phase = 'warten'; slot.t = 0; }
        break;
      }
      case 'warten': {
        // Druck baut sich auf: die Kapsel zittert, je weiter der Upload ist,
        // desto heftiger.
        const p = slot.sendung.p;
        const zittern = (0.6 + p * 2.2) * (0.5 + 0.5 * Math.sin(t * 40));
        slotPosition(amMund(10 + Math.sin(t * 53) * zittern * 0.6)
          .add(new THREE.Vector3(Math.sin(t * 47) * zittern * 0.5, 0, Math.cos(t * 41) * zittern * 0.3)));
        k.rotation.y = Math.PI * 2 + Math.sin(t * 5) * 0.15 * p;
        if (slot.sendung.ergebnis === 'ok' && t > 0.3) { slot.phase = 'ab'; slot.t = 0; puff(station.localToWorld(amMund(4)), 12, false, station.localToWorld(ACHSE.clone()).sub(station.position).normalize()); wippe.v -= 1.8; }
        if (slot.sendung.ergebnis === 'fehler' && t > 0.3) auswerfen();
        break;
      }
      case 'ab': {
        // Fffump: kurz eingesaugt, dann in der Glasröhre.
        const u = t / 0.2;
        slotPosition(amMund(10 - 70 * easeIn(u)));
        k.scale.set(1 - u * 0.2, 1 + u * 0.35, 1 - u * 0.2);
        if (u >= 1) {
          station.remove(k);
          k.scale.setScalar(1);
          k.rotation.set(0, 0, 0);
          losschicken(k, { kurve });
          slot = null;
        }
        break;
      }
    }
  }

  function auswerfen() {
    const k = slot.kapsel;
    szene.attach(k);
    const achseWelt = ACHSE.clone().transformDirection(station.matrixWorld);
    const v = achseWelt.multiplyScalar(620).add(new THREE.Vector3(zufall(-160, 160), 120, 260));
    k.userData.scharnier.rotation.x = -1.2;
    wuerfe.push({ kapsel: k, v, dreh: new THREE.Vector3(zufall(-8, 8), 0, zufall(-8, 8)), alter: 0 });
    puff(station.localToWorld(amMund(10)), 14, true);
    wippe.v += 2.4;
    lampenBlitz = { art: 'fehler', bis: uhr + 2.5 };
    slot = null;
  }

  function jubeln() {
    lampenBlitz = { art: 'gut', bis: uhr + 3 };
    wippe.v -= 2;
    trichterWippe.v += 5;
    konfetti(station.localToWorld(amMund(10)), 46);
  }

  // ── Empfangen: Kapseln kommen durch die Röhre und hüpfen heraus ──────────

  const ankuenfte = [];     // Zeitpunkte, an denen die nächste losfährt
  let ventilVerzoegerung = 0;

  function empfangsTick(dt) {
    if (ventilVerzoegerung > 0) { ventilVerzoegerung -= dt; return; }
    if (ankuenfte.length && ventilOffen) {
      ankuenfte[0] -= dt;
      if (ankuenfte[0] <= 0) {
        ankuenfte.shift();
        const k = baueKapsel(naechsteFarbe());
        losschicken(k, { kurve, v: 900, a: 1200, vmax: 2200, danach: ausspucken });
      }
    }
  }

  function ausspucken(k) {
    // Die Kapsel ist im Bauch verschwunden – jetzt schießt sie oben heraus.
    k.userData.scharnier.rotation.x = 0;
    k.rotation.set(0, 0, 0);
    k.quaternion.setFromUnitVectors(Y_ACHSE, ACHSE.clone().transformDirection(station.matrixWorld));
    k.position.copy(station.localToWorld(amMund(0)));
    k.scale.setScalar(massstab);
    const seite = Math.random() < 0.5 ? -1 : 1;
    const v = new THREE.Vector3(seite * zufall(80, 140) * massstab, zufall(430, 520) * Math.sqrt(massstab), zufall(20, 60));
    wuerfe.push({ kapsel: k, v, dreh: new THREE.Vector3(zufall(-2, 2), 0, -seite * zufall(3, 6)), alter: 0, boden: bodenY + 13 * massstab });
    puff(station.localToWorld(amMund(4)), 8);
    wippe.v -= 1.4;
    trichterWippe.v += 3;
    lampenBlitz = { art: 'gut', bis: uhr + 0.6 };
  }

  // ── Schleife ─────────────────────────────────────────────────────────────

  let letzte = performance.now();
  function bild(jetzt) {
    const dt = Math.min(0.05, (jetzt - letzte) / 1000);
    letzte = jetzt;

    if (schmutzig) { schmutzig = false; vermessen(); }
    kameraNachfuehren();

    zeiger.x += (zeiger.zx - zeiger.x) * Math.min(1, dt * 3);
    zeiger.y += (zeiger.zy - zeiger.y) * Math.min(1, dt * 3);
    hintergrund.position.set(-zeiger.x * 40, zeiger.y * 26, 0);
    for (const w of wolken) {
      w.position.x += w.userData.tempo * dt;
      if (w.position.x > breite * 2.2) w.position.x = -breite * 1.2;
    }

    stationTick(dt);
    fliegerTick(dt);
    wurfTick(dt);
    teilchenTick(dt);

    renderer.render(szene, kamera);
    requestAnimationFrame(bild);
  }

  vermessen();
  schmutzig = false;
  tageszeit();
  requestAnimationFrame(bild);

  // ── Was die Seiten damit machen können ───────────────────────────────────

  return {
    // Upload: eine leere Kapsel steht bereit, solange etwas ausgewählt ist.
    bereit(an) { bereitGewuenscht = Boolean(an); },

    // Upload: eine Datei wird über die Ablage gezogen.
    hunger(an) { hunger = Boolean(an); },

    // Upload: eine Sendung. quelle ist das Element, das in die Kapsel fliegt;
    // ein Textfeld wird dabei zu einem kleinen Zettel.
    sendung({ quelle } = {}) {
      const s = { typ: 'sendung', quelle, p: 0, ergebnis: null, farbe: naechsteFarbe() };
      if (quelle?.tagName === 'TEXTAREA') {
        const r = quelle.getBoundingClientRect();
        const text = quelle.value.trim();
        s.zettel = {
          text: text.length > 90 ? text.slice(0, 90) + '…' : text,
          rechteck: { left: r.left + r.width * 0.15, top: r.top + 6, width: r.width * 0.7, height: Math.min(r.height - 12, 90) },
        };
        s.quelle = null;
      } else if (quelle) {
        const r = quelle.getBoundingClientRect();
        const klon = quelle.cloneNode(true);
        klon.classList.add('flug-klon');
        if (r.width) s.vorlage = { klon, rechteck: { left: r.left, top: r.top, width: r.width, height: r.height } };
      }
      warteschlange.push(s);
      return {
        fortschritt(p) { s.p = clamp01(p); },
        fertig() { s.p = 1; s.ergebnis = 'ok'; },
        fehler() { s.ergebnis = 'fehler'; },
      };
    },

    // Upload: alles ist durch – Konfetti, sobald die letzte Kapsel weg ist.
    geschafft() { warteschlange.push({ typ: 'jubel' }); },

    // Upload: das große Limit ist frei. sofort: ohne Feuerwerk, etwa wenn die
    // Seite mit einer noch gültigen Freischaltung neu geladen wird.
    turbo(an = true, { sofort = false } = {}) { turboSchalten(Boolean(an), sofort); },

    // Abholen: das Ventil auf- oder zudrehen.
    ventil(offen) {
      if (!ventil || ventilOffen === Boolean(offen)) return;
      ventilOffen = Boolean(offen);
      ventil.userData.ziel = (ventil.userData.ziel ?? 0) + (offen ? -Math.PI * 3 : Math.PI * 3);
      if (offen) ventilVerzoegerung = 0.9;
      else ankuenfte.length = 0;
    },

    // Abholen: so viele Kapseln kommen an (höchstens acht, sonst dauert's).
    ankunft(anzahl) {
      const n = Math.min(8, anzahl);
      for (let i = 0; i < n; i++) ankuenfte.push(i === 0 ? 0.1 : zufall(0.35, 0.6));
    },
  };
}
