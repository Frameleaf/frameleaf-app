# Använd Frameleaf i Raycast

1. Installera Frameleaf-tillägget i Raycast och öppna **Search Photos** eller **Browse Albums**.
2. Ange adressen till ditt Library, till exempel `https://photos.example.com`. Vanlig HTTP fungerar bara för adresser i ditt eget nätverk, som `http://192.168.1.20:2283`; inloggning och bilder skickas då okrypterat i det nätverket.
3. Logga in på ditt Library i webbläsaren och välj de album som Raycast får läsa, eller ge åtkomst till hela biblioteket. Gå tillbaka till Raycast.

Markera en bild för att se en förhandsvisning. Från åtgärdspanelen kan du öppna den i Frameleaf, kopiera bilden eller länken eller ladda ned den. Nedladdningar är stora JPEG-filer utan plats- och kamerauppgifter och ersätter aldrig en befintlig fil.

För att ladda ned original slår du på **Original downloads** i tilläggets inställningar. Ditt Library ber dig att tillåta det nästa gång du ansluter; välj **Allow Original Downloads** på valfri bild för att ansluta igen. Original behåller plats- och kamerauppgifter.

En direktanslutning kräver inget Frameleaf Cloud-abonnemang; Frameleaf-reläet följer ditt Cloud-abonnemang. Om ditt Library inte låter appar registrera sig själva ber du administratören att registrera returadressen `https://raycast.com/redirect?packageName=Extension` och anger klient-ID:t i tilläggets inställningar.

Raycast kan inte se personer, platser, delningar eller andra album och kan inte ändra eller radera något. Ändra albumen under **Anslutna appar** i inställningarna för ditt Library. **Disconnect Library** återkallar åtkomsten; om ditt Library inte kan nås behåller Raycast inloggningen så att du kan försöka igen. Bilder som du redan har laddat ned finns kvar på datorn.
