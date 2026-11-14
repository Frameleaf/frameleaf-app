# Publiser fra Lightroom Classic

1. Last ned ZIP-filen med Frameleaf-pluginen, pakk den ut, og velg **File → Plug-in Manager → Add** i Lightroom Classic. Velg `frameleaf.lrplugin`.
2. I panelet **Publish Services** klikker du på **Set Up** ved siden av Frameleaf. Skriv inn adressen til biblioteket ditt, for eksempel `https://photos.example.com` eller `http://192.168.1.20:2283`. La **App-ID** stå tomt med mindre administratoren din har registrert Lightroom for deg.
3. Klikk på **Koble til…**. Nettleseren åpner Frameleaf. Logg inn, velg albumene Lightroom kan legge til bilder i, og tillat å opprette nye album hvis du vil at hver samling skal få sitt eget album. Når nettleseren går tilbake til Lightroom, viser dialogen **Koblet**.
4. Opprett en publisert samling. I innstillingene for den velger du et eksisterende Frameleaf-album eller lar **Opprett et nytt album** stå. Dra bilder inn og klikk på **Publish**.

Lightroom sender sRGB-JPEG-filer med tittel, bildetekst, nøkkelord og opphavsrett. Plasseringen fjernes med mindre du huker av for **Ta med plassering**, og personetiketter sendes aldri. Huk av for **Legg til Lightroom-nøkkelord som Frameleaf-etiketter** før du kobler til, hvis du også vil ha bildene etikettert i Frameleaf.

Frameleaf beholder hver kopi du publiserer. Hvis du publiserer et redigert bilde på nytt, legges det til en ny kopi ved siden av den forrige. Å fjerne et bilde eller en samling i Lightroom fjerner aldri noe fra Frameleaf.

Du trenger ikke Frameleaf Cloud-abonnement for å koble til på hjemmenettverket ditt eller via din egen HTTPS-adresse. For å koble til via Frameleaf-relay trenger du et abonnement som inkluderer fjerntilgang.

Hvis Lightroom sier at tilkoblingen er avsluttet, åpner du innstillingene for publiseringstjenesten og klikker på **Koble til…** igjen. **Koble fra** logger Lightroom ut og fjerner tilgangen i Frameleaf. Du kan også fjerne Lightroom i Frameleaf under **Innstillinger › Din pålogging og personvern › Tilkoblede apper**.
