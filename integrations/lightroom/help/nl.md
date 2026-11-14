# Publiceren vanuit Lightroom Classic

1. Download de ZIP van de Frameleaf-plug-in, pak die uit en kies in Lightroom Classic **File → Plug-in Manager → Add**. Selecteer `frameleaf.lrplugin`.
2. Klik in het paneel **Publish Services** op **Set Up** naast Frameleaf. Voer het adres van je bibliotheek in, bijvoorbeeld `https://photos.example.com` of `http://192.168.1.20:2283`. Laat **App-ID** leeg, tenzij je beheerder Lightroom voor je heeft geregistreerd.
3. Klik op **Verbinden…**. Je browser opent Frameleaf. Log in, kies de albums waaraan Lightroom foto’s mag toevoegen en sta het maken van nieuwe albums toe als je wilt dat elke collectie een eigen album krijgt. Zodra de browser terugkeert naar Lightroom, toont het venster **Verbonden**.
4. Maak een gepubliceerde collectie. Kies in de instellingen een bestaand Frameleaf-album of laat **Een nieuw album maken** staan. Sleep foto’s erheen en klik op **Publish**.

Lightroom stuurt sRGB-JPEG’s met titel, bijschrift, trefwoorden en auteursrecht. De locatie wordt verwijderd, tenzij je **Locatie meenemen** aanvinkt, en personen-tags worden nooit verstuurd. Vink **Lightroom-trefwoorden toevoegen als Frameleaf-tags** aan vóór het verbinden om foto’s ook in Frameleaf te taggen.

Frameleaf bewaart elke kopie die je publiceert. Als je een bewerkte foto opnieuw publiceert, komt er een nieuwe kopie naast de vorige. Een foto of collectie verwijderen in Lightroom haalt nooit iets uit Frameleaf.

Verbinden via je thuisnetwerk of je eigen HTTPS-adres vraagt geen Frameleaf Cloud-abonnement. Verbinden via de Frameleaf-relay vraagt een abonnement met toegang op afstand.

Als Lightroom meldt dat de verbinding is beëindigd, open je de instellingen van de publicatieservice en klik je opnieuw op **Verbinden…**. **Ontkoppelen** meldt Lightroom af en trekt de toegang in Frameleaf in; je kunt Lightroom ook in Frameleaf verwijderen onder **Instellingen › Jouw inloggen en privacy › Verbonden apps**.
