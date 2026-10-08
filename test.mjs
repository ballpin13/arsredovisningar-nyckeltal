// test.mjs: node test.mjs
//
// Påhittade årsredovisningar i samma form som Bolagsverkets filer. Varje
// fall träffar en egen kodväg.

import assert from 'node:assert/strict';
import { tolkaTal, lasArsredovisning, lasEsef, lasInlamning, arNyare, skrivFil, lasFil, zipEnFil, zipPoster, crc32 } from './lib.mjs';

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
test('lasArsredovisning: med koncernredovisning tas bolagets egna värden, inte koncernens', () => {
  const seg = (namn) => '<xbrli:segment><se-gen-base:RedovisningInformation' + namn + 'Segment /></xbrli:segment>';
  const html = rapport([
    ktx('jur0', '2025-01-01', '2025-12-31', seg('JuridiskPerson')), ktx('kon0', '2025-01-01', '2025-12-31', seg('Koncern')),
    ktx('gen0', null, '2025-12-31', seg('Generell')),
    tal('Nettoomsattning', 'kon0', '900'), tal('Nettoomsattning', 'jur0', '400'), tal('Aktiekapital', 'gen0', '50 000'),
  ]);
  const r = lasArsredovisning(html);
  assert.equal(r.nettoomsattning, '400');
  assert.equal(r.aktiekapital, '50000');
  assert.equal(lasArsredovisning(rapport([ktx('kon0', '2025-01-01', '2025-12-31', seg('Koncern')), tal('Nettoomsattning', 'kon0', '900')])).nettoomsattning, '');
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

// ESEF: börsbolagens rapport med IFRS-taxonomin. Kontexterna har LEI i
// stället för organisationsnummer, och beloppen står ofta i miljoner.
const GRUND = { orgnr: '5599990001', fran: '2025-01-01', till: '2025-12-31', undertecknad: '', sate: '', valuta: '', esef: '' };
const ifrs = (namn, ctx, varde, prefix = 'ifrs-full') => '<ix:nonFraction name="' + prefix + ':' + namn + '" contextRef="' + ctx + '" unitRef="SEK" decimals="-6" scale="6" format="ixt4:num-comma-decimal">' + varde + '</ix:nonFraction>';
function esef(delar) {
  return '<html xmlns:ifrs-full="https://xbrl.ifrs.org/taxonomy/2024-03-27/ifrs-full"><body><ix:header><ix:resources>'
    + ktx('period0', '2025-01-01', '2025-12-31') + ktx('period1', '2024-01-01', '2024-12-31')
    + ktx('balans0', null, '2025-12-31') + ktx('balans1', null, '2024-12-31')
    + ktx('dim0', null, '2025-12-31', '<xbrli:scenario><xbrldi:explicitMember dimension="ifrs-full:ComponentsOfEquityAxis">ifrs-full:RetainedEarningsMember</xbrldi:explicitMember></xbrli:scenario>')
    + '<xbrli:unit id="SEK"><xbrli:measure>iso4217:SEK</xbrli:measure></xbrli:unit>'
    + '</ix:resources></ix:header>' + delar.join('') + '</body></html>';
}

test('lasEsef: IFRS-elementen till samma kolumner, årets värden i hela kronor', () => {
  const r = lasEsef(esef([ifrs('Revenue', 'period1', '10'), ifrs('Revenue', 'period0', '11 828'), ifrs('ProfitLossFromOperatingActivities', 'period0', '<span>8</span>53'),
    ifrs('CurrentLiabilities', 'balans0', '2 920')]), GRUND);
  assert.equal(r.nettoomsattning, '11828000000');
  assert.equal(r.rorelseresultat, '853000000');
  assert.equal(r.kortfristiga_skulder, '2920000000');
  assert.equal(r.orgnr, '5599990001');
});
test('lasEsef: koncern när resultatet delas på moderbolagets ägare, annars bolag', () => {
  assert.equal(lasEsef(esef([ifrs('ProfitLoss', 'period0', '5'), ifrs('ProfitLossAttributableToOwnersOfParent', 'period0', '5')]), GRUND).esef, 'koncern');
  assert.equal(lasEsef(esef([ifrs('ProfitLoss', 'period0', '5')]), GRUND).esef, 'bolag');
});
test('lasEsef: totalen går före en del, i båda ordningarna', () => {
  const r = lasEsef(esef([ifrs('RevenueFromSaleOfGoods', 'period0', '7'), ifrs('Revenue', 'period0', '9')]), GRUND);
  assert.equal(r.nettoomsattning, '9000000');
  assert.equal(lasEsef(esef([ifrs('Revenue', 'period0', '9'), ifrs('RevenueFromSaleOfGoods', 'period0', '7')]), GRUND).nettoomsattning, '9000000');
  assert.equal(lasEsef(esef([ifrs('RevenueFromSaleOfGoods', 'period0', '7')]), GRUND).nettoomsattning, '7000000');
});
test('lasEsef: hyresintäkter är omsättning för ett fastighetsbolag, men sist', () => {
  assert.equal(lasEsef(esef([ifrs('RentalIncomeFromInvestmentProperty', 'period0', '4 354')]), GRUND).nettoomsattning, '4354000000');
  assert.equal(lasEsef(esef([ifrs('RentalIncomeFromInvestmentProperty', 'period0', '1'), ifrs('Revenue', 'period0', '2')]), GRUND).nettoomsattning, '2000000');
});
test('lasEsef: varor och tjänster utan summa ger ingen omsättning', () => {
  const r = lasEsef(esef([ifrs('RevenueFromSaleOfGoods', 'period0', '7'), ifrs('RevenueFromRenderingOfServices', 'period0', '2'), ifrs('ProfitLoss', 'period0', '1')]), GRUND);
  assert.equal(r.nettoomsattning, '');
  assert.equal(r.arets_resultat, '1000000');
});
test('lasEsef: eget kapital med dimension tas inte, moderbolagets ägares andel är reserv', () => {
  const r = lasEsef(esef([ifrs('Equity', 'dim0', '99'), ifrs('EquityAttributableToOwnersOfParent', 'balans0', '1 743'), ifrs('Assets', 'balans0', '9 353')]), GRUND);
  assert.equal(r.eget_kapital, '1743000000');
  assert.equal(r.soliditet, '18.6');
  assert.equal(lasEsef(esef([ifrs('EquityAttributableToOwnersOfParent', 'balans0', '1'), ifrs('Equity', 'balans0', '2')]), GRUND).eget_kapital, '2000000');
});
test('lasEsef: prefixet ur rapporten, bolagets egna element tas inte', () => {
  const html = esef([ifrs('Revenue', 'period0', '3', 'ifrs'), ifrs('Revenue', 'period0', '4', 'abc'), ifrs('Assets', 'balans0', '6', 'abc')])
    .replace('<html ', '<html xmlns:ifrs="https://xbrl.ifrs.org/taxonomy/2024-03-27/ifrs-full" ');
  const r = lasEsef(html, GRUND);
  assert.equal(r.nettoomsattning, '3000000');
  assert.equal(r.tillgangar, '');
  assert.equal(lasEsef(esef([ifrs('Revenue', 'period0', '4', 'abc')]), GRUND), null);
});

// En inlämning som posterna i bolagets zip.
const post = (namn, innehall) => ({ namn, data: () => Buffer.from(innehall) });
const intyg = rapport([]);
const paket = (html) => ({ namn: 'abc.zip', data: () => zipEnFil('Bolag-2025-12-31-sv/reports/Bolag-2025-12-31-sv.xhtml', Buffer.from(html)) });

test('lasInlamning: intyget utan belopp och ESEF-paketet ger ESEF-raden', () => {
  const [r, ...ovriga] = lasInlamning([post('intyg.xhtml', intyg), paket(esef([ifrs('Revenue', 'period0', '5')]))], '5599990001_2025-12-31.zip');
  assert.equal(ovriga.length, 0);
  assert.equal(r.nettoomsattning, '5000000');
  assert.equal(r.till, '2025-12-31');
});
test('lasInlamning: en årsredovisning med belopp går före paketet', () => {
  const [r] = lasInlamning([post('ar.xhtml', rapport([tal('Nettoomsattning', 'period0', '2 000')])), paket(esef([ifrs('Revenue', 'period0', '5')]))]);
  assert.equal(r.nettoomsattning, '2000');
  assert.equal(r.esef, '');
});
test('lasInlamning: paket utan rapport under reports/ ger intygets rad', () => {
  const fel = { namn: 'abc.zip', data: () => zipEnFil('Bolag/annat/r.xhtml', Buffer.from(esef([ifrs('Revenue', 'period0', '5')]))) };
  const [r] = lasInlamning([post('intyg.xhtml', intyg), fel]);
  assert.equal(r.nettoomsattning, '');
  assert.equal(r.till, '2025-12-31');
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
test('skrivFil: esef står sist, och en äldre fil utan kolumnen läses med den tom', () => {
  const r = lasEsef(esef([ifrs('Revenue', 'period0', '5')]), GRUND);
  const fil = skrivFil(new Map([[r.orgnr, r]])).toString('utf8').split('\n');
  assert.ok(fil[0].endsWith('\tutdelning\tesef'));
  assert.ok(fil[1].endsWith('\tbolag'));
  const gammal = lasFil(fil.map((rad) => rad.split('\t').slice(0, -1).join('\t')).join('\n'));
  assert.equal(gammal.get('5599990001').esef, '');
});

test('zipEnFil: läses av zipPoster och har rätt CRC', () => {
  const data = Buffer.from('orgnr\tfran\nååå\n', 'utf8');
  const [post] = zipPoster(zipEnFil('a.txt', data, new Date('2026-10-07T12:00:00Z')));
  assert.equal(post.namn, 'a.txt');
  assert.deepEqual(post.data(), data);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

console.log(antal + ' tester gick igenom');
