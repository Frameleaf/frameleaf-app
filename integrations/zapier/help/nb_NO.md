# Frameleaf Connect for Zapier

Privat beta. Triggere, søk, handlinger og filer er implementert; driftet kvalifisering og Zapier-gjennomgang kreves fortsatt. Ikke publiser denne pakken.

Tilkoblingen ber om library:read, library:download, albums:write, tags:write, photos:upload, boards:upload og events:read. Velg ved samtykket i Frameleaf nøyaktig hvilke egne album som kan leses, og hvilke album eller arbeidsområder det kan skrives til. Å lese hele Library er et eksplisitt valg. Personer, deling, fjerning og sletting blir aldri forespurt.

Zapier må kunne nå en offentlig HTTPS-adresse til Library. Egen HTTPS krever ingen Frameleaf Cloud-plan; Frameleaf-relé krever en kvalifisert plan. Zapier-abonnementer og bruksgrenser er separate. Tilgang kun via LAN støttes ikke.

Finn den nøyaktige returadressen for den private appen i Zapier. En Frameleaf-administrator registrerer den i Connect og gir en ikke-hemmelig klient-ID. Skriv inn serverens kanoniske opprinnelse og ID, og gi samtykke i nettleseren. Lim aldri inn tokens i et Zap-felt.

Hendelsestriggere sjekker de nyeste 1000 samsvarende hendelsene ved hver spørring. Hvis det er mer enn 1000 hendelser mellom to spørringer, utelates de eldste; dette er ikke en tapsfri synkronisering.

Handlinger som oppretter noe, krever en kilde-ID som er den samme for samme element, for eksempel ID-en fra forrige trinn. Gjentakelser, nye forsøk og samtidige kjøringer oppretter da ett album eller én fil, ikke duplikater.

Filer hentes først når et senere trinn bruker dem, med tilkoblingens gjeldende tilgang. Tilbakekalling av tilgang i Frameleafs tilkoblede apper stopper flere filer; det kan ikke fjerne kopier som allerede er sendt andre steder. Å fjerne Zapier-tilkoblingen tilbakekaller ikke Frameleaf-tillatelsen.

Kvalifiser den driftede appen før publisering: nettleser-OAuth med den ekte tilbakekallsadressen, samtidige Zaps som deler én utløpende tilkobling og gir én trygg rotasjon, et tapt oppdateringssvar, tilbakekalling samt hver trigger, søk, handling og fil mot et test-Library.
