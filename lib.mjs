// lib.mjs
//
// Rena funktioner för bygget: zip-arkiv in och ut, nyckeltalen ur en
// årsredovisning i iXBRL, och filen med en rad per bolag. Inga beroenden.

import { inflateRawSync, deflateRawSync } from 'node:zlib';

// ---- Zip -----------------------------------------------------------------

// Posterna i ett zip-arkiv: [{ namn, data }] där data packas upp först när
// den hämtas. Läser innehållsförteckningen i slutet av arkivet.
export function zipPoster(buf) {
  let eocd = -1;
  for (let o = buf.length - 22; o >= Math.max(0, buf.length - 22 - 65535); o--) {
    if (buf.readUInt32LE(o) === 0x06054b50) { eocd = o; break; }
  }
  if (eocd === -1) throw new Error('Trasigt zip-arkiv: hittar inte innehållsförteckningen');
  const antal = buf.readUInt16LE(eocd + 10);
  let o = buf.readUInt32LE(eocd + 16);
  if (antal === 0xffff || o === 0xffffffff) throw new Error('Zip64 stöds inte');
  const ut = [];
  for (let i = 0; i < antal; i++) {
    if (buf.readUInt32LE(o) !== 0x02014b50) throw new Error('Trasigt zip-arkiv: innehållsförteckningen');
    const metod = buf.readUInt16LE(o + 10);
    const packad = buf.readUInt32LE(o + 20);
    const nl = buf.readUInt16LE(o + 28);
    const el = buf.readUInt16LE(o + 30);
    const kl = buf.readUInt16LE(o + 32);
    const lokal = buf.readUInt32LE(o + 42);
    const namn = buf.toString('utf8', o + 46, o + 46 + nl);
    o += 46 + nl + el + kl;
    ut.push({
      namn,
      data() {
        const start = lokal + 30 + buf.readUInt16LE(lokal + 26) + buf.readUInt16LE(lokal + 28);
        const bit = buf.subarray(start, start + packad);
        if (metod === 0) return bit;
        if (metod === 8) return inflateRawSync(bit);
        throw new Error('Okänd komprimering ' + metod + ' i ' + namn);
      },
    });
  }
  return ut;
}

const CRC_TABELL = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABELL[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Ett zip-arkiv med en fil. Datumet i innehållsförteckningen är byggdagen:
// Nexus Container visar det på knappen.
export function zipEnFil(namn, data, datum = new Date()) {
  const n = Buffer.from(namn, 'utf8');
  const packad = deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const tid = (datum.getUTCHours() << 11) | (datum.getUTCMinutes() << 5) | (datum.getUTCSeconds() >> 1);
  const dag = ((datum.getUTCFullYear() - 1980) << 9) | ((datum.getUTCMonth() + 1) << 5) | datum.getUTCDate();
  const lokal = Buffer.alloc(30);
  lokal.writeUInt32LE(0x04034b50, 0);
  lokal.writeUInt16LE(20, 4);
  lokal.writeUInt16LE(0x0800, 6);
  lokal.writeUInt16LE(8, 8);
  lokal.writeUInt16LE(tid, 10);
  lokal.writeUInt16LE(dag, 12);
  lokal.writeUInt32LE(crc, 14);
  lokal.writeUInt32LE(packad.length, 18);
  lokal.writeUInt32LE(data.length, 22);
  lokal.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(tid, 12);
  central.writeUInt16LE(dag, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(packad.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(n.length, 28);
  central.writeUInt32LE(0, 42);
  const slut = Buffer.alloc(22);
  slut.writeUInt32LE(0x06054b50, 0);
  slut.writeUInt16LE(1, 8);
  slut.writeUInt16LE(1, 10);
  slut.writeUInt32LE(central.length + n.length, 12);
  slut.writeUInt32LE(lokal.length + n.length + packad.length, 16);
  return Buffer.concat([lokal, n, packad, central, n, slut]);
}

// ---- Årsredovisningen ----------------------------------------------------
//
// Inline XBRL: värdena står i HTML-texten, märkta med ix:nonFraction (tal)
// och ix:nonNumeric (text och datum). Varje värde pekar på en kontext som
// säger vilken period det gäller. Bara räkenskapsårets egna värden tas,
// inte jämförelseårets, och inga värden med dimensioner (uppdelningar).

// Kolumnerna i utfilen, i ordning. `tag` är elementet i taxonomin och
// `typ` om värdet gäller hela året (period) eller årets sista dag (balans).
export const KOLUMNER = [
  { namn: 'nettoomsattning', tag: 'Nettoomsattning', typ: 'period' },
  { namn: 'rorelseresultat', tag: 'Rorelseresultat', typ: 'period' },
  { namn: 'resultat_efter_fin', tag: 'ResultatEfterFinansiellaPoster', typ: 'period' },
  { namn: 'arets_resultat', tag: 'AretsResultat', typ: 'period' },
  { namn: 'tillgangar', tag: 'Tillgangar', typ: 'balans' },
  { namn: 'eget_kapital', tag: 'EgetKapital', typ: 'balans' },
  { namn: 'soliditet', tag: 'Soliditet', typ: 'balans' },
  { namn: 'aktiekapital', tag: 'Aktiekapital', typ: 'balans' },
  { namn: 'kassa_bank', tag: 'KassaBank', typ: 'balans' },
  { namn: 'kortfristiga_skulder', tag: 'KortfristigaSkulder', typ: 'balans' },
  { namn: 'anstallda', tag: 'MedelantaletAnstallda', typ: 'period' },
  { namn: 'personalkostnader', tag: 'Personalkostnader', typ: 'period' },
  { namn: 'utdelning', tag: 'ForslagDispositionUtdelning', typ: 'balans' },
];

export const RUBRIK = ['orgnr', 'fran', 'till', 'undertecknad', 'sate', 'valuta', ...KOLUMNER.map((k) => k.namn)];

const attr = (s, namn) => {
  const m = s.match(new RegExp('\\s' + namn + '\\s*=\\s*"([^"]*)"', 'i'));
  return m ? m[1] : null;
};
const utanTaggar = (s) => s.replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;| /g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/\s+/g, ' ').trim();

// Talet i ett ix:nonFraction. Formaten i filerna är ixt:numspacecomma och
// ixt:numcomma (komma som decimaltecken). Formatets namn slutar med
// decimaltecknet: numdotcomma har komma, numcommadot och num-dot-decimal
// punkt. Utan format är det punkt.
// `scale` flyttar decimalen: 3 är tusental kronor, -2 en procentsats som
// bråk (soliditet "29,8" med scale -2 är 0,298). sign="-" är negativt.
export function tolkaTal(text, format, scale, sign) {
  const t = utanTaggar(text);
  if (/zero|dash/i.test(format || '') || /^[-–—]$/.test(t)) return 0;
  const punkt = !format || /dot(-?decimal)?$/i.test(format);
  let s = t.replace(punkt ? /[^\d.]/g : /[^\d,]/g, '');
  if (!punkt) s = s.replace(',', '.');
  if (!/\d/.test(s)) return null;
  let v = Number(s);
  if (!Number.isFinite(v)) return null;
  v *= 10 ** Number(scale || 0);
  return sign === '-' ? -v : v;
}

// Kontexterna: id → { start, slut, dim }. `slut` är endDate eller instant.
function kontexter(html) {
  const ut = new Map();
  for (const m of html.matchAll(/<xbrli:context\b([^>]*)>([\s\S]*?)<\/xbrli:context>/gi)) {
    const id = attr(m[1], 'id');
    const k = m[2];
    // Elementen kan ha egna attribut: <xbrli:startDate xmlns:xbrli="…">.
    const dag = (t) => (k.match(new RegExp('<xbrli:' + t + '\\b[^>]*>\\s*([0-9-]{10})', 'i')) || [])[1] || null;
    ut.set(id, {
      start: dag('startDate'),
      slut: dag('endDate') || dag('instant'),
      dim: /<xbrli:(segment|scenario)\b/i.test(k),
    });
  }
  return ut;
}

function enheter(html) {
  const ut = new Map();
  for (const m of html.matchAll(/<xbrli:unit\b([^>]*)>([\s\S]*?)<\/xbrli:unit>/gi)) {
    const v = (m[2].match(/iso4217:([A-Z]{3})/) || [])[1];
    if (v) ut.set(attr(m[1], 'id'), v);
  }
  return ut;
}

// Textvärdena (ix:nonNumeric) per namn utan prefix.
function texter(html) {
  const ut = new Map();
  for (const m of html.matchAll(/<ix:nonNumeric\b([^>]*?)(?:\/>|>([\s\S]*?)<\/ix:nonNumeric>)/gi)) {
    const namn = (attr(m[1], 'name') || '').split(':').pop();
    if (!ut.has(namn)) ut.set(namn, []);
    ut.get(namn).push(utanTaggar(m[2] || ''));
  }
  return ut;
}

// Nyckeltalen ur en årsredovisning, eller null om det inte är någon.
// `filnamn` ("5561234567_2025-12-31.zip") ger organisationsnumret om
// texten saknar det.
export function lasArsredovisning(html, filnamn = '') {
  const txt = texter(html);
  const forst = (namn) => (txt.get(namn) || []).find(Boolean) || '';
  const orgnr = (forst('Organisationsnummer').replace(/\D/g, '') || (String(filnamn).match(/(\d{10})_/) || [])[1] || '');
  const till = forst('RakenskapsarSistaDag').match(/\d{4}-\d{2}-\d{2}/)?.[0] || '';
  if (!/^\d{10}$/.test(orgnr) || !till) return null;
  const fran = forst('RakenskapsarForstaDag').match(/\d{4}-\d{2}-\d{2}/)?.[0] || '';
  const undertecknad = [...(txt.get('UndertecknandeDatum') || []), ...(txt.get('UndertecknandeArsredovisningDatum') || [])]
    .map((d) => (d.match(/\d{4}-\d{2}-\d{2}/) || [])[0]).filter(Boolean).sort().pop() || '';

  const ktx = kontexter(html);
  const enh = enheter(html);
  const passar = (id, typ) => {
    const k = ktx.get(id);
    if (!k || k.dim || k.slut !== till) return false;
    if (typ === 'balans') return true;
    return !!k.start && (!fran || k.start === fran);
  };
  // Samma värde kan stå på flera ställen, till exempel i tusental kronor i
  // flerårsöversikten och i kronor i resultaträkningen. Det med minst
  // `scale` är det mest exakta och tas.
  const varden = {};
  const skala = {};
  let valuta = '';
  for (const m of html.matchAll(/<ix:nonFraction\b([^>]*?)(?:\/>|>([\s\S]*?)<\/ix:nonFraction>)/gi)) {
    const a = m[1];
    if (m[2] === undefined) continue;
    const tag = (attr(a, 'name') || '').split(':').pop();
    const kol = KOLUMNER.find((k) => k.tag === tag);
    if (!kol || !passar(attr(a, 'contextRef'), kol.typ)) continue;
    const sc = Number(attr(a, 'scale') || 0);
    if (kol.namn in varden && skala[kol.namn] <= sc) continue;
    const v = tolkaTal(m[2], attr(a, 'format'), sc, attr(a, 'sign'));
    if (v === null) continue;
    varden[kol.namn] = v;
    skala[kol.namn] = sc;
    const enhet = enh.get(attr(a, 'unitRef'));
    if (enhet && !valuta) valuta = enhet;
  }
  const rad = { orgnr, fran, till, undertecknad, sate: forst('ForetagetsSate'), valuta: valuta === 'SEK' ? '' : valuta };
  for (const k of KOLUMNER) {
    const v = varden[k.namn];
    if (v === undefined) rad[k.namn] = '';
    // Soliditeten som procent med en decimal, övrigt i hela kronor (antal
    // anställda kan ha en decimal).
    else if (k.namn === 'soliditet') rad[k.namn] = String(Math.round(v * 1000) / 10);
    else if (k.namn === 'anstallda') rad[k.namn] = String(Math.round(v * 10) / 10);
    else rad[k.namn] = String(Math.round(v));
  }
  return rad;
}

// Nyare går före: senare räkenskapsår, och vid samma år den senast
// undertecknade (en rättad årsredovisning ersätter den första).
export function arNyare(ny, gammal) {
  if (!gammal) return true;
  if (ny.till !== gammal.till) return ny.till > gammal.till;
  return (ny.undertecknad || '') >= (gammal.undertecknad || '');
}

// ---- Utfilen -------------------------------------------------------------
//
// Tabb mellan fälten, UTF-8, rubrikrad först. En rad per bolag.

export function skrivFil(bolag) {
  const rader = [...bolag.values()].sort((a, b) => (a.orgnr < b.orgnr ? -1 : 1))
    .map((r) => RUBRIK.map((k) => String(r[k] ?? '').replace(/[\t\r\n]+/g, ' ')).join('\t'));
  return Buffer.from([RUBRIK.join('\t'), ...rader].join('\n') + '\n', 'utf8');
}

export function lasFil(text) {
  const rader = String(text).split('\n').filter(Boolean);
  const bolag = new Map();
  if (!rader.length) return bolag;
  const rubrik = rader[0].split('\t');
  for (const rad of rader.slice(1)) {
    const f = rad.split('\t');
    const r = {};
    rubrik.forEach((k, i) => { r[k] = f[i] ?? ''; });
    for (const k of RUBRIK) if (!(k in r)) r[k] = '';
    if (r.orgnr) bolag.set(r.orgnr, r);
  }
  return bolag;
}
