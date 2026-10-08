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

// Kolumnerna i utfilen, i ordning. `tag` är elementet i den svenska
// taxonomin och `typ` om värdet gäller hela året (period) eller årets sista
// dag (balans). `ifrs` är elementen i IFRS-taxonomin som börsbolagen
// använder (ESEF), det första som finns går före. En koncern utan minoritet
// taggar ibland bara moderbolagets ägares andel av eget kapital och
// resultat, som då är hela beloppet. Soliditeten och antalet
// anställda har inget IFRS-element: soliditeten räknas ut, antalet
// anställda saknas.
export const KOLUMNER = [
  { namn: 'nettoomsattning', tag: 'Nettoomsattning', typ: 'period',
    ifrs: ['Revenue', 'RevenueFromContractsWithCustomers', ['RevenueFromSaleOfGoods', 'RevenueFromRenderingOfServices']] },
  { namn: 'rorelseresultat', tag: 'Rorelseresultat', typ: 'period', ifrs: ['ProfitLossFromOperatingActivities'] },
  { namn: 'resultat_efter_fin', tag: 'ResultatEfterFinansiellaPoster', typ: 'period', ifrs: ['ProfitLossBeforeTax'] },
  { namn: 'arets_resultat', tag: 'AretsResultat', typ: 'period', ifrs: ['ProfitLoss', 'ProfitLossAttributableToOwnersOfParent'] },
  { namn: 'tillgangar', tag: 'Tillgangar', typ: 'balans', ifrs: ['Assets'] },
  { namn: 'eget_kapital', tag: 'EgetKapital', typ: 'balans', ifrs: ['Equity', 'EquityAttributableToOwnersOfParent'] },
  { namn: 'soliditet', tag: 'Soliditet', typ: 'balans', ifrs: [] },
  { namn: 'aktiekapital', tag: 'Aktiekapital', typ: 'balans', ifrs: ['IssuedCapital'] },
  { namn: 'kassa_bank', tag: 'KassaBank', typ: 'balans', ifrs: ['CashAndCashEquivalents'] },
  { namn: 'kortfristiga_skulder', tag: 'KortfristigaSkulder', typ: 'balans', ifrs: ['CurrentLiabilities'] },
  { namn: 'anstallda', tag: 'MedelantaletAnstallda', typ: 'period', ifrs: [] },
  { namn: 'personalkostnader', tag: 'Personalkostnader', typ: 'period', ifrs: ['EmployeeBenefitsExpense'] },
  { namn: 'utdelning', tag: 'ForslagDispositionUtdelning', typ: 'balans',
    ifrs: ['DividendsProposedOrDeclaredBeforeFinancialStatementsAuthorisedForIssueButNotRecognisedAsDistributionToOwners'] },
];

// `esef` är tomt för en vanlig årsredovisning. För ett börsbolag vars
// siffror kommer ur ESEF-rapporten är det "koncern" när rapporten är en
// koncernredovisning och annars "bolag". Kolumnen står sist, så att äldre
// läsare som letar kolumnerna via rubriken inte påverkas.
export const RUBRIK = ['orgnr', 'fran', 'till', 'undertecknad', 'sate', 'valuta', ...KOLUMNER.map((k) => k.namn), 'esef'];

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

// Talen för räkenskapsåret ur en iXBRL-rapport. `valj(namn)` säger vilken
// kolumn ett element hör till och dess rang ({ kol, rang } eller null):
// lägre rang går före. Bara räkenskapsårets egna värden tas, inte
// jämförelseårets, och inga värden med dimensioner (uppdelningar).
function nyckeltal(html, fran, till, valj) {
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
  // `scale` är det mest exakta och tas. Två olika element med samma rang
  // (försäljning av varor och av tjänster utan summa) är bara delar, och
  // då lämnas kolumnen tom.
  const varden = {};
  const basta = {};
  let valuta = '';
  for (const m of html.matchAll(/<ix:nonFraction\b([^>]*?)(?:\/>|>([\s\S]*?)<\/ix:nonFraction>)/gi)) {
    const a = m[1];
    if (m[2] === undefined) continue;
    const namn = attr(a, 'name') || '';
    const val = valj(namn);
    const tag = namn.split(':').pop();
    if (!val || !passar(attr(a, 'contextRef'), val.kol.typ)) continue;
    const sc = Number(attr(a, 'scale') || 0);
    const b = basta[val.kol.namn];
    if (b && b.rang < val.rang) continue;
    if (b && b.rang === val.rang && b.tag !== tag) { b.delar = true; continue; }
    if (b && b.rang === val.rang && b.skala <= sc) continue;
    const v = tolkaTal(m[2], attr(a, 'format'), sc, attr(a, 'sign'));
    if (v === null) continue;
    varden[val.kol.namn] = v;
    basta[val.kol.namn] = { rang: val.rang, tag, skala: sc, delar: false };
    const enhet = enh.get(attr(a, 'unitRef'));
    if (enhet && !valuta) valuta = enhet;
  }
  for (const [k, b] of Object.entries(basta)) if (b.delar) delete varden[k];
  return { varden, valuta };
}

// Nyckeltalen ur ett börsbolags ESEF-rapport, eller null om den inte har
// några. Rapporten följer IFRS och saknar organisationsnummer och
// räkenskapsår i svensk form: de tas ur `grund`, raden ur intyget som
// lämnas in tillsammans med rapporten. Soliditeten räknas ut ur eget
// kapital och tillgångar.
export function lasEsef(html, grund) {
  if (!grund || !grund.till) return null;
  // Prefixet för IFRS-taxonomin står i rapporten, oftast "ifrs-full".
  const prefix = new Set(['ifrs-full']);
  for (const m of html.matchAll(/xmlns:([\w.-]+)\s*=\s*"[^"]*xbrl\.ifrs\.org\/taxonomy\/[^"]*\/ifrs-full"/gi)) prefix.add(m[1]);
  const { varden, valuta } = nyckeltal(html, grund.fran, grund.till, (namn) => {
    const [p, lokal] = namn.split(':');
    if (!prefix.has(p)) return null;
    for (const kol of KOLUMNER) {
      const rang = kol.ifrs.findIndex((t) => (Array.isArray(t) ? t.includes(lokal) : t === lokal));
      if (rang !== -1) return { kol, rang };
    }
    return null;
  });
  if (!Object.keys(varden).length) return null;
  if (varden.eget_kapital !== undefined && varden.tillgangar) varden.soliditet = varden.eget_kapital / varden.tillgangar;
  // En koncernredovisning delar upp resultatet och det egna kapitalet på
  // moderbolagets ägare och minoriteten.
  const koncern = /name="[^"]*:(ProfitLoss|Equity|ComprehensiveIncome)AttributableTo(OwnersOfParent|NoncontrollingInterests)"/.test(html);
  return radAv({ ...grund, valuta, esef: koncern ? 'koncern' : 'bolag' }, varden);
}

// Har raden något nyckeltal alls?
export const harNyckeltal = (rad) => KOLUMNER.some((k) => rad[k.namn] !== '');

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

  const { varden, valuta } = nyckeltal(html, fran, till, (namn) => {
    const kol = KOLUMNER.find((k) => k.tag === namn.split(':').pop());
    return kol ? { kol, rang: 0 } : null;
  });
  return radAv({ orgnr, fran, till, undertecknad, sate: forst('ForetagetsSate'), valuta, esef: '' }, varden);
}

// Raden i utfilen av grunduppgifterna och de insamlade talen.
function radAv(grund, varden) {
  const rad = { ...grund, valuta: grund.valuta === 'SEK' ? '' : grund.valuta };
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

// En inlämning: posterna i bolagets zip i veckofilen. Oftast är det
// årsredovisningen som xhtml. Ett börsbolag lämnar i stället ett intyg som
// xhtml, med räkenskapsåret men utan belopp, och ESEF-paketet som en zip
// i zipen med rapporten under reports/. Paketet läses bara när ingen
// xhtml har nyckeltal. Ger raderna som hittas.
export function lasInlamning(poster, filnamn = '') {
  const rader = [];
  const paket = [];
  for (const f of poster) {
    if (/\.x?html?$/i.test(f.namn)) {
      const rad = lasArsredovisning(f.data().toString('utf8'), filnamn);
      if (rad) rader.push(rad);
    } else if (/\.zip$/i.test(f.namn)) paket.push(f);
  }
  if (!rader.length || rader.some(harNyckeltal)) return rader;
  for (const p of paket) {
    for (const f of zipPoster(p.data())) {
      if (!/(^|\/)reports\/[^/]+\.x?html?$/i.test(f.namn)) continue;
      const rad = lasEsef(f.data().toString('utf8'), rader[0]);
      if (rad) return [rad];
    }
  }
  return rader;
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
