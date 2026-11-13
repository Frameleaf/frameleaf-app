# Importer Frameleaf-bilder

1. Installer og aktiver ZIP-filen Frameleaf Connect i WordPress.
2. Åpne **Media → Frameleaf** som administrator, og legg til HTTPS-opprinnelsen til din Library. Tillat private nettverk bare for din egen Library. Hvis automatisk registrering er deaktivert, registrerer du den nøyaktige returadressen i Frameleaf Connect og oppgir klient-ID.
3. Hver redaktør velger **Koble til Frameleaf** og gir tilgang til valgte album. WordPress-returadressen krever HTTPS med et pålitelig sertifikat.
4. Velg **Frameleaf** i medievelgeren i Gutenberg eller den klassiske redigereren. Bla i et album eller søk, bekreft den lokale kopien og importer bildet. Rediger bildetekst og alternativ tekst med WordPress-kontrollene.

Importerte JPEG-, PNG- og WebP-bilder blir vanlige WordPress-vedlegg med nettstedets synlighet. De blir værende etter frakobling eller tilbakekalling av tilgang. Ingen bakgrunnssynkronisering eller sletting utføres. Gjentatt import laster ned gjeldende versjon for å sammenligne SHA-256: identisk innhold gjenbruker vedlegget, endret innhold oppretter en ny kopi.

WordPress-serveren må nå Library og stole på sertifikatet. Lokal eller egen HTTPS krever ingen Frameleaf Cloud-plan; Frameleaf-relé krever den eksisterende planen. Filer må holde seg innenfor WordPress-grensen og programtilleggets grense på 16 MiB / 40 megapiksler.

Kontroller adresse og sertifikat ved tilkoblingsfeil, og koble til igjen. Usikker tokenfornyelse krever ny tilkobling. Frakobling prøver tilbakekallingen igjen og beholder krypterte opplysninger til den lykkes. Etter endring av WordPress-nøkler eller salt må du tilbakekalle tilgangen i Frameleaf, bekrefte her og velge **Tilbakestill etter endring av WordPress-nøkler**.

En mislykket import fjerner midlertidige data. Avbrutt publisering med usikker kvittering blokkerer automatiske duplikater. Be administratoren kontrollere det lokale vedlegget og den ventende `frameleaf_imports`-oppføringen før gjenoppretting. Slett aldri ventende oppføringer uten kontroll. Støtte: support@frameleaf.app.

Frameleaf krever PHP cURL med HTTPS-støtte og en direkte nettverksrute til Library. Forespørsler til Library bruker ikke HTTP-proxyer.
