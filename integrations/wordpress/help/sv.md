# Importera Frameleaf-bilder

1. Installera och aktivera ZIP-filen Frameleaf Connect i WordPress.
2. Öppna **Media → Frameleaf** som administratör och lägg till HTTPS-ursprunget för din Library. Tillåt privata nätverk endast för din egen Library. Om automatisk registrering är avstängd registrerar du den exakta återanropsadressen i Frameleaf Connect och anger klient-ID.
3. Varje redaktör väljer **Anslut Frameleaf** och godkänner valda album. WordPress-återanropet kräver HTTPS med ett betrott certifikat.
4. Välj **Frameleaf** i medieväljaren i Gutenberg eller den klassiska redigeraren. Bläddra i ett album eller sök, godkänn den lokala kopian och importera bilden. Redigera bildtext och alternativtext med WordPress-kontrollerna.

Importerade JPEG-, PNG- och WebP-bilder blir vanliga WordPress-bilagor med webbplatsens synlighet. De finns kvar efter frånkoppling eller återkallad åtkomst. Ingen bakgrundssynkronisering eller borttagning sker. Upprepad import hämtar den aktuella versionen för SHA-256-jämförelse: identiskt innehåll återanvänder bilagan, ändrat innehåll skapar en ny kopia.

WordPress-servern måste nå Library och lita på certifikatet. Lokal eller egen HTTPS kräver ingen Frameleaf Cloud-plan; Frameleaf-relä kräver sin befintliga plan. Filer måste rymmas inom WordPress-gränsen och pluginens gräns på 16 MiB / 40 megapixlar.

Kontrollera adress och certifikat vid anslutningsfel och anslut igen. Osäker tokenförnyelse kräver ny anslutning. Frånkoppling försöker återkalla igen och behåller krypterade uppgifter tills det lyckas. Efter ändring av WordPress-nycklar eller salt ska du återkalla åtkomsten i Frameleaf, bekräfta här och välja **Återställ efter ändring av WordPress-nycklar**.

Misslyckad import tar bort tillfälliga data. Avbruten publicering med osäker kvittens blockerar automatiska dubbletter. Be administratören kontrollera den lokala bilagan och den väntande posten i `frameleaf_imports` före återställning. Radera aldrig väntande poster utan kontroll. Support: support@frameleaf.app.

Frameleaf kräver PHP cURL med HTTPS-stöd och en direkt nätverksväg till Library. Begäranden till Library använder inte HTTP-proxyservrar.
