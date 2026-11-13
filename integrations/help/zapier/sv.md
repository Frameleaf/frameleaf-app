# Frameleaf Connect för Zapier

Endast anslutningsgrunden finns. Åtgärder, sökningar, filer och utlösare är ännu inte tillgängliga. Publicera inte paketet och använd det inte i produktion.

Den här testanslutningen begär bara library:read. Välj exakt dina egna album i Frameleafs samtycke; läsning av hela biblioteket kräver ett uttryckligt val. Original, personer och skrivbehörighet begärs inte.

Zapier måste kunna nå en offentlig HTTPS-adress för Library. Egen HTTPS kräver ingen Frameleaf Cloud-plan; Frameleaf-relä kräver en giltig plan. Zapier-abonnemang och användningsgränser är separata. Enbart LAN-åtkomst stöds inte.

Hämta den exakta returadressen för den privata appen i Zapier. En Frameleaf-administratör registrerar den i Connect och lämnar ett icke-hemligt klient-ID. Ange serverns kanoniska ursprung och ID och ge samtycke i webbläsaren. Klistra aldrig in tokens i ett Zap-fält.

OAuth i molntjänsten och samtidiga förnyelser måste verifieras innan fler funktioner läggs till. Kontrollera att flera Zaps med samma anslutning gör en säker rotation, sparar alla nya tokens, behåller autentiseringsuppgifterna efter ett osäkert svar och återkallar åtkomst korrekt. Källkoden bevisar inte dessa plattformsbeteenden.
