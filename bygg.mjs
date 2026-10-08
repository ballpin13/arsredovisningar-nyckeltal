// bygg.mjs
//
// Bygger arsredovisningar.zip: nyckeltalen ur de årsredovisningar som
// lämnats in digitalt till Bolagsverket, en rad per bolag (det senaste
// räkenskapsåret). Inga namn på personer tas med.
//
//   node bygg.mjs --forra forra --ut ut
//
// --forra  mapp med förra körningens arsredovisningar.zip och
//          behandlade.txt. Saknas den byggs filen från början.
// --ut     mapp där den nya filen skrivs.
// --fran-ar  första inlämningsår att läsa (2025). Det räcker för det
//          senaste räkenskapsåret för de flesta bolag.
// --minuter  tid att arbeta innan det som hunnits sparas (330). Det som
//          återstår tas vid nästa körning.
// --max    högst så många veckofiler (för prov).
// --lokal  läs en nedladdad veckofil i stället för att hämta (för prov).
// --omlas  fil med veckofiler (en per rad) att läsa om fast de redan är
//          behandlade, till exempel efter en ändring i inläsningen. De som
//          inte hinns med skrivs till omlas.txt i --ut.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { zipPoster, zipEnFil, lasInlamning, arNyare, skrivFil, lasFil } from './lib.mjs';

const BAS = 'https://vardefulla-datamangder.bolagsverket.se/arsredovisningar-bulkfiler';
const PREFIX = 'arsredovisningar/';

const arg = (namn, standard) => {
  const i = process.argv.indexOf('--' + namn);
  return i === -1 ? standard : process.argv[i + 1];
};
const allaArg = (namn) => process.argv.flatMap((a, i) => (a === '--' + namn ? [process.argv[i + 1]] : []));

const forra = arg('forra', null);
const utMapp = arg('ut', 'ut');
const franAr = Number(arg('fran-ar', '2025'));
const slutTid = Date.now() + Number(arg('minuter', '330')) * 60e3;
const max = Number(arg('max', 'Infinity'));
const lokala = allaArg('lokal');
const omlas = new Set(arg('omlas', null)
  ? readFileSync(arg('omlas'), 'utf8').split('\n').map((r) => r.split('\t')[0].trim()).filter(Boolean) : []);

// Svarar servern inte (503) väntas en halv, en och en och en halv minut.
async function hamta(url, forsok = 4) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (i >= forsok) throw new Error(url + ': ' + e.message);
      await new Promise((r) => setTimeout(r, 30000 * i));
    }
  }
}

// Veckofilerna hos Bolagsverket: [{ key, etag, storlek }], i namnordning.
// Listan är en S3-lista med högst 1000 poster per sida.
async function listaVeckofiler() {
  const ut = [];
  let marker = '';
  for (;;) {
    const xml = (await hamta(BAS + '?prefix=' + PREFIX + '&marker=' + encodeURIComponent(marker))).toString('utf8');
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const f = (t) => (m[1].match(new RegExp('<' + t + '>([^<]*)</' + t + '>')) || [])[1] || '';
      ut.push({ key: f('Key'), etag: f('ETag').replace(/&#34;|"/g, ''), storlek: Number(f('Size')) });
    }
    if (!/<IsTruncated>true<\/IsTruncated>/.test(xml) || !ut.length) break;
    marker = ut[ut.length - 1].key;
  }
  return ut.filter((v) => v.key.endsWith('.zip')).sort((a, b) => (a.key < b.key ? -1 : 1));
}

// En veckofil: zip med en zip per årsredovisning, som i sin tur har
// årsredovisningen som xhtml (eller intyget och ESEF-paketet, se
// lasInlamning).
function lasVeckofil(buf, bolag) {
  let antal = 0;
  let fel = 0;
  for (const inre of zipPoster(buf)) {
    try {
      const filer = inre.namn.toLowerCase().endsWith('.zip') ? zipPoster(inre.data()) : [inre];
      for (const rad of lasInlamning(filer, inre.namn)) {
        antal++;
        if (arNyare(rad, bolag.get(rad.orgnr))) bolag.set(rad.orgnr, rad);
      }
    } catch (e) {
      fel++;
      if (fel <= 3) console.warn('  ' + inre.namn + ': ' + e.message);
    }
  }
  return { antal, fel };
}

// ---- Förra körningen -------------------------------------------------------

let bolag = new Map();
const behandlade = new Map();
if (forra && existsSync(join(forra, 'arsredovisningar.zip'))) {
  const [post] = zipPoster(readFileSync(join(forra, 'arsredovisningar.zip')));
  bolag = lasFil(post.data().toString('utf8'));
  console.log('Förra filen: ' + bolag.size + ' bolag');
}
if (forra && existsSync(join(forra, 'behandlade.txt'))) {
  for (const rad of readFileSync(join(forra, 'behandlade.txt'), 'utf8').split('\n').filter(Boolean)) {
    const [key, etag] = rad.split('\t');
    behandlade.set(key, etag);
  }
  console.log('Behandlade veckofiler: ' + behandlade.size);
}

// ---- Nya veckofiler --------------------------------------------------------

let kvar = [];
let klar = true;
if (lokala.length) {
  for (const fil of lokala) {
    const r = lasVeckofil(readFileSync(fil), bolag);
    console.log(fil + ': ' + r.antal + ' årsredovisningar, ' + r.fel + ' fel');
  }
} else {
  const alla = await listaVeckofiler();
  const att = alla.filter((v) => {
    // Mappen är inlämningsåret. Nya filer hamnar alltid i innevarande år,
    // så gränsen stänger bara ute de äldsta åren.
    const ar = Number((v.key.match(/\/(\d{4})\//) || [])[1]);
    return ar >= franAr && (behandlade.get(v.key) !== v.etag || omlas.has(v.key));
  });
  console.log('Veckofiler hos Bolagsverket: ' + alla.length + ', att läsa: ' + att.length);
  const gor = att.slice(0, max);
  const lasta = new Set();
  let nasta = gor.length ? hamta(BAS + '/' + gor[0].key) : null;
  for (let i = 0; i < gor.length; i++) {
    const v = gor[i];
    let buf;
    try {
      buf = await nasta;
    } catch (e) {
      // Svarar inte servern sparas det som hunnits. Har inget alls lästs
      // stannar bygget med fel, så att det inte startar om sig i en slinga.
      console.log(e.message);
      if (!lasta.size) throw e;
      console.log('Resten tas vid nästa körning.');
      break;
    }
    // Nästa hämtas medan den här läses.
    nasta = i + 1 < gor.length && Date.now() < slutTid ? hamta(BAS + '/' + gor[i + 1].key) : null;
    const r = lasVeckofil(buf, bolag);
    behandlade.set(v.key, v.etag);
    lasta.add(v.key);
    console.log(v.key + ': ' + r.antal + ' årsredovisningar, ' + r.fel + ' fel, ' + bolag.size + ' bolag');
    if (Date.now() >= slutTid && i + 1 < gor.length) {
      console.log('Tiden är slut. Resten tas vid nästa körning.');
      break;
    }
  }
  kvar = att.filter((v) => !lasta.has(v.key));
  klar = kvar.length === 0;
  if (omlas.size) {
    mkdirSync(utMapp, { recursive: true });
    writeFileSync(join(utMapp, 'omlas.txt'), [...omlas].filter((k) => !lasta.has(k)).map((k) => k + '\n').join(''));
  }
}

// ---- Utfilerna -------------------------------------------------------------

mkdirSync(utMapp, { recursive: true });
writeFileSync(join(utMapp, 'arsredovisningar.zip'), zipEnFil('arsredovisningar.txt', skrivFil(bolag)));
writeFileSync(join(utMapp, 'behandlade.txt'),
  [...behandlade].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, e]) => k + '\t' + e).join('\n') + '\n');
writeFileSync(join(utMapp, 'status.txt'), klar ? 'klar\n' : 'ofullstandig\n');
const senaste = [...behandlade.keys()].sort().pop() || '';
const idag = new Date().toISOString().slice(0, 10);
writeFileSync(join(utMapp, 'notering.md'), [
  'Byggd ' + idag + '. ' + bolag.size + ' bolag.',
  '',
  'Senast inlästa veckofil: ' + (senaste.replace(PREFIX, '') || 'ingen') + '.',
  klar ? '' : 'Ofullständig: ' + kvar.length + ' veckofiler återstår och läses vid nästa körning.',
  '',
  'Källa: Bolagsverket, digitalt inlämnade årsredovisningar (värdefulla datamängder).',
].filter((r, i, a) => r || a[i - 1]).join('\n') + '\n');
console.log((klar ? 'Klar' : 'Ofullständig') + ': ' + bolag.size + ' bolag');
