# Frameleaf-afbeeldingen importeren

1. Installeer en activeer het ZIP-bestand Frameleaf Connect in WordPress.
2. Open als beheerder **Media → Frameleaf** en voeg de HTTPS-oorsprong van je Library toe. Sta een privénetwerk alleen toe voor je eigen Library. Registreer bij uitgeschakelde automatische registratie het exact getoonde retouradres in Frameleaf Connect en vul de client-ID in.
3. Elke redacteur kiest **Frameleaf verbinden** en geeft toegang tot geselecteerde albums. Het WordPress-retouradres vereist HTTPS met een vertrouwd certificaat.
4. Kies in de mediakiezer van Gutenberg of de klassieke editor **Frameleaf**. Blader door een album of zoek, bevestig de lokale kopie en importeer de afbeelding. Bewerk bijschrift en alternatieve tekst met de WordPress-bediening.

Geïmporteerde JPEG-, PNG- en WebP-afbeeldingen worden gewone WordPress-bijlagen met de zichtbaarheid van de site. Ze blijven na verbreken of intrekken van toegang bestaan. Er is geen achtergrondsynchronisatie of verwijdering. Een herhaalde import downloadt de huidige weergave voor SHA-256-vergelijking: identieke inhoud gebruikt dezelfde bijlage; gewijzigde inhoud maakt een nieuwe kopie.

De WordPress-server moet de Library bereiken en het certificaat vertrouwen. Lokaal of eigen HTTPS vereist geen Frameleaf Cloud-abonnement; Frameleaf-relay vereist het bestaande abonnement. Bestanden moeten binnen de WordPress-uploadlimiet en de pluginlimiet van 16 MiB / 40 megapixel vallen.

Controleer bij verbindingsproblemen het adres en certificaat en maak opnieuw verbinding. Een onzekere tokenvernieuwing vereist opnieuw verbinden. Verbreken probeert de intrekking opnieuw en bewaart versleutelde gegevens tot het lukt. Trek na wijziging van WordPress-sleutels of salts de toegang in Frameleaf in, bevestig dat hier en kies **Opnieuw instellen na wijziging van WordPress-sleutels**.

Een mislukte import verwijdert tijdelijke gegevens. Een onderbroken publicatie met onzekere bevestiging blokkeert automatische duplicaten. Laat de beheerder de lokale bijlage en het openstaande `frameleaf_imports`-record controleren voor herstel. Wis nooit ongecontroleerd openstaande records. Ondersteuning: support@frameleaf.app.

Frameleaf vereist PHP cURL met HTTPS-ondersteuning en een directe netwerkverbinding met de Library. Library-verzoeken gebruiken geen HTTP-proxy’s.
