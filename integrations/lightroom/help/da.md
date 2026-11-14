# Udgiv fra Lightroom Classic

1. Download Frameleaf-pluginets ZIP-fil, pak den ud, og vælg **File → Plug-in Manager → Add** i Lightroom Classic. Vælg `frameleaf.lrplugin`.
2. Klik på **Set Up** ud for Frameleaf i panelet **Publish Services**. Skriv adressen på dit bibliotek, for eksempel `https://photos.example.com` eller `http://192.168.1.20:2283`. Lad **App-ID** stå tomt, medmindre din administrator har registreret Lightroom til dig.
3. Klik på **Forbind…**. Din browser åbner Frameleaf. Log ind, vælg de album, Lightroom må tilføje fotos til, og tillad oprettelse af nye album, hvis du vil have et eget album til hver samling. Når browseren giver kontrollen tilbage til Lightroom, viser dialogen **Forbundet**.
4. Opret en udgivet samling. Vælg i dens indstillinger et eksisterende Frameleaf-album, eller lad **Opret et nyt album** stå. Træk fotos ind, og klik på **Publish**.

Lightroom sender sRGB-JPEG-filer med deres titel, billedtekst, nøgleord og ophavsret. Placeringen fjernes, medmindre du markerer **Medtag placering**, og personmærker sendes aldrig. Markér **Tilføj Lightroom-nøgleord som Frameleaf-tags**, før du forbinder, hvis du også vil have fotoene mærket i Frameleaf.

Frameleaf beholder hver kopi, du udgiver. Når du udgiver et redigeret foto igen, tilføjes en ny kopi ved siden af den tidligere. Hvis du fjerner et foto eller en samling i Lightroom, fjernes der aldrig noget fra Frameleaf.

Du behøver ikke en Frameleaf Cloud-plan for at forbinde på dit hjemmenetværk eller via din egen HTTPS-adresse. Hvis du vil forbinde via Frameleaf-relay, skal du have en plan, der inkluderer fjernadgang.

Hvis Lightroom siger, at forbindelsen er ophørt, skal du åbne udgivelsestjenestens indstillinger og klikke på **Forbind…** igen. **Afbryd** logger Lightroom ud og fjerner dets adgang i Frameleaf. Du kan også fjerne Lightroom i Frameleaf under **Indstillinger › Dit login og privatliv › Forbundne apps**.
