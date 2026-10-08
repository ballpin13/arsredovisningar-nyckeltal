# Nyckeltal ur årsredovisningar

En fil med nyckeltal för svenska aktiebolag, ur de årsredovisningar som
lämnats in digitalt till Bolagsverket. En rad per bolag, det senaste
räkenskapsåret. Filen byggs om den 2:a varje månad.

**Ladda ner:**
https://github.com/ballpin13/arsredovisningar-nyckeltal/releases/download/senaste/arsredovisningar.zip

Under [Releases](../../releases/tag/senaste) står när filen byggdes och
vilken veckofil som lästes senast.

## Innehåll

`arsredovisningar.zip` innehåller `arsredovisningar.txt`: UTF-8, tabb mellan
fälten, rubrikrad först.

| Kolumn | Innehåll |
|---|---|
| orgnr | Organisationsnummer, tio siffror |
| fran, till | Räkenskapsåret, ÅÅÅÅ-MM-DD |
| undertecknad | Dagen årsredovisningen skrevs under |
| sate | Styrelsens säte, om det står i årsredovisningen |
| valuta | Tomt för kronor, annars valutakoden |
| nettoomsattning | Kronor |
| rorelseresultat | Kronor |
| resultat_efter_fin | Resultat efter finansiella poster, kronor |
| arets_resultat | Kronor |
| tillgangar | Summa tillgångar, kronor |
| eget_kapital | Kronor |
| soliditet | Procent, en decimal |
| aktiekapital | Kronor |
| kassa_bank | Kronor |
| kortfristiga_skulder | Kronor |
| anstallda | Medelantal anställda |
| personalkostnader | Kronor |
| utdelning | Föreslagen utdelning, kronor |
| esef | Tomt, eller `koncern`/`bolag` för ett börsbolag (se nedan) |

Ett tomt fält betyder att värdet inte står märkt i årsredovisningen.

Börsbolag lämnar ett intyg utan belopp och årsredovisningen i EU:s format
ESEF, enligt IFRS. Då tas siffrorna ur ESEF-rapporten, och `esef` säger
om de gäller koncernen eller bolaget. Resultatet efter finansiella poster
är där resultat före skatt, soliditeten räknas ut ur eget kapital och
tillgångar, och antal anställda saknas.
Personnamn tas inte med.

Bara aktiebolag som lämnat in årsredovisningen digitalt finns med. Den
läses från inlämningsår 2025 och framåt.

## Källa

Bolagsverket, digitalt inlämnade årsredovisningar:
https://vardefulla-datamangder.bolagsverket.se/arsredovisningar-bulkfiler?prefix=arsredovisningar/

Uppgifterna är öppna data enligt EU:s förordning om värdefulla datamängder
(2023/138) och får återanvändas.

## Bygga själv

Inga beroenden, Node 22 eller senare.

```bash
node test.mjs
node bygg.mjs --ut ut                    # från början
node bygg.mjs --forra forra --ut ut      # bygger vidare på förra filen
node bygg.mjs --forra forra --ut ut --omlas lista.txt   # läser om veckofilerna i listan
```
