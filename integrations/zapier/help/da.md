# Frameleaf Connect til Zapier

Privat beta. Triggere, søgninger, handlinger og filer er implementeret; hostet kvalificering og Zapier-gennemgang kræves stadig. Udgiv ikke denne pakke.

Forbindelsen anmoder om library:read, library:download, albums:write, tags:write, photos:upload, boards:upload og events:read. Vælg ved samtykket i Frameleaf præcis hvilke egne album der må læses, og hvilke album eller arbejdsområder der må skrives til. At læse hele Library er et eksplicit valg. Personer, deling, fjernelse og sletning anmodes aldrig om.

Zapier skal kunne nå en offentlig HTTPS-adresse til Library. Egen HTTPS kræver ikke en Frameleaf Cloud-plan; Frameleaf-relæ kræver en berettiget plan. Zapier-abonnementer og forbrugsgrænser er separate. Ren LAN-adgang understøttes ikke.

Find den nøjagtige returadresse for den private app i Zapier. En Frameleaf-administrator registrerer den i Connect og giver et ikke-hemmeligt klient-id. Indtast serverens kanoniske oprindelse og id, og giv samtykke i browseren. Indsæt aldrig tokens i et Zap-felt.

Hændelsestriggere tjekker de nyeste 1000 matchende hændelser ved hver forespørgsel. Hvis der er mere end 1000 hændelser mellem to forespørgsler, udelades de ældste; det er ikke en tabsfri synkronisering.

Handlinger, der opretter noget, kræver et kilde-id, der er det samme for det samme element, for eksempel id'et fra det forrige trin. Gentagelser, nye forsøg og samtidige kørsler opretter så ét album eller én fil, ikke dubletter.

Filer hentes først, når et senere trin bruger dem, med forbindelsens aktuelle adgang. Tilbagekaldelse af adgang i Frameleafs tilsluttede apps stopper flere filer; det kan ikke fjerne kopier, der allerede er sendt andre steder hen. Fjernelse af Zapier-forbindelsen tilbagekalder ikke Frameleaf-tilladelsen.

Kvalificér den hostede app før udgivelse: browser-OAuth med den rigtige tilbagekaldsadresse, samtidige Zaps der deler én udløbende forbindelse og giver én sikker rotation, et mistet opdateringssvar, tilbagekaldelse samt hver trigger, søgning, handling og fil mod et test-Library.
