# Frameleaf verbinden met n8n

Gebruik zelf gehoste n8n in de normale modus met één proces. Wachtrijmodus, meerdere workers en n8n Cloud worden niet ondersteund. De interface van de n8n-node is Engelstalig.

1. Installeer de Frameleaf-communitynode en voeg een Frameleaf OAuth2 API-verbinding toe.
2. Kopieer de exacte OAuth Redirect URL. Vraag de beheerder van je Library deze te registreren als openbare PKCE-client met een vertrouwde HTTPS-callback.
3. Vul Library URL en de verstrekte Client ID in. Kies het kleinste benodigde machtigingsprofiel en maak verbinding.
4. Selecteer leesbare albums en schrijfbestemmingen afzonderlijk. Maak opnieuw verbinding na wijzigingen aan het adres of de machtigingen.

Directe toegang via LAN of eigen HTTPS vereist geen Frameleaf Cloud-abonnement. Relaytoegang vereist een geschikt abonnement. Laat certificaatcontrole en n8n-netwerkbeveiliging ingeschakeld; sta zo nodig alleen je Library toe.

Koppel Source ID bij het maken van albums en uploaden aan een vaste identiteit van de brongebeurtenis. Uploads vereisen ook een vaste Source Date. Houd ID, datum, bestandsnaam, inhoud en bestemming gelijk bij nieuwe pogingen. Wacht de aangegeven Retry-After-tijd af. Bestanden gebruiken binaire velden van n8n; downloads hebben een instelbare groottelimiet.

Triggers voor nieuwe foto's, toevoegingen aan albums en Studio-exports komen in een latere versie. Start workflows tot die tijd met een andere trigger, zoals een planning of een webhook.

Trek de toegang in Frameleaf in en verwijder de n8n-verbinding om te ontkoppelen. Eerder elders opgeslagen kopieën blijven bestaan. Neem contact op met support@frameleaf.app en vermeld de bewerking en HTTP-status, zonder inloggegevens, privébestandsnamen of media.
