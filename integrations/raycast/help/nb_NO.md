# Bruk Frameleaf i Raycast

1. Installer Frameleaf-utvidelsen i Raycast, og åpne **Search Photos** eller **Browse Albums**.
2. Skriv inn adressen til ditt Library, for eksempel `https://photos.example.com`. Vanlig HTTP fungerer bare for adresser på ditt eget nettverk, som `http://192.168.1.20:2283`; pålogging og bilder sendes da ukryptert på det nettverket.
3. Logg på ditt Library i nettleseren, og velg albumene Raycast kan lese, eller gi tilgang til hele biblioteket. Gå tilbake til Raycast.

Velg et bilde for å se en forhåndsvisning. Fra handlingspanelet kan du åpne det i Frameleaf, kopiere bildet eller lenken, eller laste det ned. Nedlastinger er store JPEG-filer uten posisjon og kameraopplysninger og erstatter aldri en eksisterende fil.

For å laste ned originaler slår du på **Original downloads** i innstillingene for utvidelsen. Ditt Library ber deg om å tillate det neste gang du kobler til; velg **Allow Original Downloads** på et hvilket som helst bilde for å koble til på nytt. Originaler beholder posisjon og kameraopplysninger.

En direkte tilkobling krever ikke et Frameleaf Cloud-abonnement; Frameleaf-relé følger Cloud-abonnementet ditt. Hvis ditt Library ikke lar apper registrere seg selv, ber du administratoren om å registrere returadressen `https://raycast.com/redirect?packageName=Extension`, og skriver inn klient-ID-en i innstillingene for utvidelsen.

Raycast kan ikke se personer, steder, deling eller andre album, og kan ikke endre eller slette noe. Endre albumene under **Tilkoblede apper** i innstillingene for ditt Library. **Disconnect Library** trekker tilbake tilgangen; hvis ditt Library ikke kan nås, beholder Raycast påloggingen slik at du kan prøve igjen. Bilder du allerede har lastet ned, blir værende på datamaskinen.
