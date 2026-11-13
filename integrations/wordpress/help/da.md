# Importér Frameleaf-billeder

1. Installér og aktivér ZIP-filen Frameleaf Connect i WordPress.
2. Åbn **Medier → Frameleaf** som administrator, og tilføj HTTPS-oprindelsen for din Library. Tillad kun private netværk for din egen Library. Hvis automatisk registrering er slået fra, skal du registrere den nøjagtige returadresse i Frameleaf Connect og angive klient-ID.
3. Hver redaktør vælger **Forbind Frameleaf** og giver adgang til valgte album. WordPress-returadressen kræver HTTPS med et betroet certifikat.
4. Vælg **Frameleaf** i medievælgeren i Gutenberg eller den klassiske editor. Gennemse et album eller søg, bekræft den lokale kopi, og importér billedet. Redigér billedtekst og alternativ tekst med WordPress-kontrollerne.

Importerede JPEG-, PNG- og WebP-billeder bliver almindelige WordPress-vedhæftninger med webstedets synlighed. De bliver efter afbrydelse eller tilbagekaldelse af adgang. Der sker ingen synkronisering eller sletning i baggrunden. Gentagen import henter den aktuelle version for at sammenligne SHA-256: identisk indhold genbruger vedhæftningen, ændret indhold opretter en ny kopi.

WordPress-serveren skal kunne nå Library og stole på certifikatet. Lokal eller egen HTTPS kræver ingen Frameleaf Cloud-plan; Frameleaf-relæ kræver den eksisterende plan. Filer skal overholde WordPress-grænsen og pluginets grænse på 16 MiB / 40 megapixel.

Kontrollér adresse og certifikat ved forbindelsesfejl, og opret forbindelse igen. Usikker tokenfornyelse kræver ny forbindelse. Afbrydelse prøver tilbagekaldelsen igen og beholder krypterede oplysninger, indtil det lykkes. Efter ændring af WordPress-nøgler eller salts skal du tilbagekalde adgangen i Frameleaf, bekræfte her og vælge **Nulstil efter ændring af WordPress-nøgler**.

En mislykket import fjerner midlertidige data. Afbrudt publicering med usikker kvittering blokerer automatiske dubletter. Bed administratoren kontrollere den lokale vedhæftning og den ventende `frameleaf_imports`-post før gendannelse. Slet aldrig ventende poster uden kontrol. Support: support@frameleaf.app.

Frameleaf kræver PHP cURL med HTTPS-understøttelse og en direkte netværksvej til Library. Anmodninger til Library bruger ikke HTTP-proxyer.
