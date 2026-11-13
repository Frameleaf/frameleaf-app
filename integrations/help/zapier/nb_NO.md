# Frameleaf Connect for Zapier

Bare tilkoblingsgrunnlaget er tilgjengelig. Handlinger, søk, filer og utløsere er ikke tilgjengelige ennå. Ikke publiser pakken eller bruk den i produksjon.

Denne testtilkoblingen ber bare om library:read. Velg nøyaktig dine egne album i Frameleaf-samtykket; lesing av hele biblioteket krever et uttrykkelig valg. Originaler, personer og skrivetilgang blir ikke forespurt.

Zapier må kunne nå en offentlig HTTPS-adresse til Library. Egen HTTPS krever ingen Frameleaf Cloud-plan; Frameleaf-relé krever en kvalifisert plan. Zapier-abonnementer og bruksgrenser er separate. Tilgang kun via LAN støttes ikke.

Finn den nøyaktige returadressen for den private appen i Zapier. En Frameleaf-administrator registrerer den i Connect og gir en ikke-hemmelig klient-ID. Skriv inn serverens kanoniske opprinnelse og ID, og gi samtykke i nettleseren. Lim aldri inn tokens i et Zap-felt.

Hostet OAuth og samtidige fornyelser må verifiseres før flere funksjoner legges til. Kontroller at flere Zaps med én delt tilkobling utfører én sikker rotasjon, lagrer alle nye tokens, beholder legitimasjonen etter et usikkert svar og tilbakekaller riktig. Kildekoden beviser ikke disse plattformegenskapene.
