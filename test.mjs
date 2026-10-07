// test.mjs: node test.mjs
//
// Påhittade årsredovisningar i samma form som Bolagsverkets filer. Varje
// fall träffar en egen kodväg.

import assert from 'node:assert/strict';
import { tolkaTal, lasArsredovisning, arNyare, skrivFil, lasFil, zipEnFil, zipPoster, crc32 } from './lib.mjs';

let antal = 0;
const test = (namn, fn) => { fn(); antal++; console.log('ok  ' + namn); };

const ktx = (id, start, slut, dim = '') => '<xbrli:context id="' + id + '"><xbrli:entity><xbrli:identifier scheme="http://www.bolagsverket.se">559999-0001</xbrli:identifier>' + dim + '</xbrli:entity><xbrli:period>'
  + (start ? '<xbrli:startDate xmlns:xbrli="http://www.xbrl.org/2003/instance">' + start + '</xbrli:startDate><xbrli:endDate>' + slut + '</xbrli:endDate>' : '<xbrli:instant>' + slut + '</xbrli:instant>')
  + '</xbrli:period></xbrli:context>';
const tal = (namn, ctx, varde, extra = '') => '<ix:nonFraction name="se-gen-base:' + namn + '" contextRef="' + ctx + '" unitRef="SEK" decimals="INF" scale="0" format="ixt:numspacecomma"' + extra + '>' + varde + '</ix:nonFraction>';
const text = (namn, varde, prefix = 'se-cd-base') => '<ix:nonNumeric name="' + prefix + ':' + namn + '" contextRef="period0">' + varde + '</ix:nonNumeric>';

function rapport(delar) {
  return '<html><body><ix:header><ix:resources>'
    + ktx('period0', '2025-01-01', '2025-12-31') + ktx('period1', '2024-01-01', '2024-12-31')
    + ktx('balans0', null, '2025-12-31') + ktx('balans1', null, '2024-12-31')
    + ktx('dim0', null, '2025-12-31', '<xbrli:segment><xbrldi:explicitMember dimension="x">y</xbrldi:explicitMember></xbrli:segment>')
    + '<xbrli:unit id="SEK"><xbrli:measure>iso4217:SEK</xbrli:measure></xbrli:unit>'
    + '<xbrli:unit id="EUR"><xbrli:measure>iso4217:EUR</xbrli:measure></xbrli:unit>'
    + '</ix:resources></ix:header>'
    + text('Organisationsnummer', '559999-0001') + text('RakenskapsarForstaDag', '2025-01-01') + text('RakenskapsarSistaDag', '2025-12-31')
    + delar.join('') + '</body></html>';
}

test('tolkaTal: mellanslag som tusentalsavgränsare och komma som decimal', () => {
  assert.equal(tolkaTal('48 230 000', 'ixt:numspacecomma', 0), 48230000);
  assert.equal(tolkaTal('29,8', 'ixt:numspacecomma', -2), 0.298);
});
test('tolkaTal: scale 3 är tusental', () => assert.equal(tolkaTal('1 234', 'ixt:numspacecomma', 3), 1234000));
test('tolkaTal: sign="-" ger negativt', () => assert.equal(tolkaTal('990', 'ixt:numspacecomma', 0, '-'), -990));
test('tolkaTal: punkt som decimal när formatet slutar på dot', () => {
  assert.equal(tolkaTal('1,234.5', 'ixt:numcommadot', 0), 1234.5);
  assert.equal(tolkaTal('1.234,5', 'ixt:numdotcomma', 0), 1234.5);
});
test('tolkaTal: streck är noll, tomt är inget', () => {
  assert.equal(tolkaTal('–', 'ixt:numspacecomma', 0), 0);
  assert.equal(tolkaTal('', 'ixt:numspacecomma', 0), null);
});
test('tolkaTal: nbsp och taggar inuti', () => assert.equal(tolkaTal('<span>12&nbsp;345</span>', 'ixt:numspacecomma', 0), 12345));

test('lasArsredovisning: årets värden, inte jämförelseårets', () => {
  const r = lasArsredovisning(rapport([tal('Nettoomsattning', 'period1', '1 000'), tal('Nettoomsattning', 'period0', '2 000')]));
  assert.equal(r.nettoomsattning, '2000');
});
test('lasArsredovisning: värden med dimension tas inte', () => {
  const r = lasArsredovisning(rapport([tal('Aktiekapital', 'dim0', '1'), tal('Aktiekapital', 'balans0', '50 000')]));
  assert.equal(r.aktiekapital, '50000');
});
test('lasArsredovisning: balansvärde från årets sista dag, inte förra årets', () => {
  const r = lasArsredovisning(rapport([tal('EgetKapital', 'balans1', '5'), tal('EgetKapital', 'balans0', '7')]));
  assert.equal(r.eget_kapital, '7');
});
test('lasArsredovisning: det mest exakta värdet går före tusental', () => {
  const r = lasArsredovisning(rapport([
    tal('AretsResultat', 'period0', '1', ' sign="-"').replace('scale="0"', 'scale="3"'),
    tal('AretsResultat', 'period0', '990', ' sign="-"'),
  ]));
  assert.equal(r.arets_resultat, '-990');
});
test('lasArsredovisning: soliditet som procent', () => {
  const r = lasArsredovisning(rapport([tal('Soliditet', 'balans0', '29,8').replace('scale="0"', 'scale="-2"')]));
  assert.equal(r.soliditet, '29.8');
});
test('lasArsredovisning: senaste underskriftsdatum och säte', () => {
  const r = lasArsredovisning(rapport([text('UndertecknandeDatum', '2026-03-01', 'se-gen-base'), text('UndertecknandeDatum', '2026-03-05', 'se-gen-base'), text('ForetagetsSate', 'Göteborg')]));
  assert.equal(r.undertecknad, '2026-03-05');
  assert.equal(r.sate, 'Göteborg');
});
test('lasArsredovisning: annan valuta än SEK märks', () => {
  const r = lasArsredovisning(rapport([tal('Nettoomsattning', 'period0', '5').replace('unitRef="SEK"', 'unitRef="EUR"')]));
  assert.equal(r.valuta, 'EUR');
  assert.equal(lasArsredovisning(rapport([tal('Nettoomsattning', 'period0', '5')])).valuta, '');
});
test('lasArsredovisning: organisationsnummer ur filnamnet när texten saknar det', () => {
  const html = rapport([]).replace(text('Organisationsnummer', '559999-0001'), '');
  assert.equal(lasArsredovisning(html, '5591234567_2025-12-31.zip').orgnr, '5591234567');
  assert.equal(lasArsredovisning(html), null);
});
test('lasArsredovisning: namn på undertecknare tas inte med', () => {
  const r = lasArsredovisning(rapport([text('UnderskriftHandlingTilltalsnamn', 'Anna', 'se-gen-base'), text('UnderskriftHandlingEfternamn', 'Svensson', 'se-gen-base')]));
  assert.ok(!JSON.stringify(r).includes('Anna') && !JSON.stringify(r).includes('Svensson'));
});

test('arNyare: senare räkenskapsår, och vid samma år senare underskrift', () => {
  assert.ok(arNyare({ till: '2025-12-31' }, { till: '2024-12-31' }));
  assert.ok(!arNyare({ till: '2024-12-31' }, { till: '2025-12-31' }));
  assert.ok(arNyare({ till: '2025-12-31', undertecknad: '2026-05-02' }, { till: '2025-12-31', undertecknad: '2026-05-01' }));
  assert.ok(!arNyare({ till: '2025-12-31', undertecknad: '2026-04-01' }, { till: '2025-12-31', undertecknad: '2026-05-01' }));
});

test('skrivFil och lasFil: samma bolag tillbaka', () => {
  const r = lasArsredovisning(rapport([tal('Nettoomsattning', 'period0', '2 000')]));
  const bolag = lasFil(skrivFil(new Map([[r.orgnr, r]])).toString('utf8'));
  assert.deepEqual(bolag.get('5599990001'), r);
});

test('zipEnFil: läses av zipPoster och har rätt CRC', () => {
  const data = Buffer.from('orgnr\tfran\nååå\n', 'utf8');
  const [post] = zipPoster(zipEnFil('a.txt', data, new Date('2026-10-07T12:00:00Z')));
  assert.equal(post.namn, 'a.txt');
  assert.deepEqual(post.data(), data);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

console.log(antal + ' tester gick igenom');
