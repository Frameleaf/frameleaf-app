# Frameleaf Connect til Zapier

Kun forbindelsesgrundlaget er tilgængeligt. Handlinger, søgninger, filer og udløsere er endnu ikke tilgængelige. Udgiv ikke pakken, og brug den ikke i produktion.

Denne testforbindelse anmoder kun om library:read. Vælg præcis dine egne album i Frameleafs samtykke; læsning af hele biblioteket kræver et udtrykkeligt valg. Originaler, personer og skriveadgang anmodes ikke.

Zapier skal kunne nå en offentlig HTTPS-adresse til Library. Egen HTTPS kræver ikke en Frameleaf Cloud-plan; Frameleaf-relæ kræver en berettiget plan. Zapier-abonnementer og forbrugsgrænser er separate. Ren LAN-adgang understøttes ikke.

Find den nøjagtige returadresse for den private app i Zapier. En Frameleaf-administrator registrerer den i Connect og giver et ikke-hemmeligt klient-id. Indtast serverens kanoniske oprindelse og id, og giv samtykke i browseren. Indsæt aldrig tokens i et Zap-felt.

Hostet OAuth og samtidige fornyelser skal verificeres før flere funktioner tilføjes. Kontrollér, at flere Zaps med én delt forbindelse udfører én sikker rotation, gemmer alle nye tokens, bevarer legitimationsoplysninger efter et usikkert svar og tilbagekalder korrekt. Kildekoden beviser ikke disse platformsegenskaber.
