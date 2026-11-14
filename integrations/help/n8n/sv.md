# Anslut Frameleaf till n8n

Använd en egen n8n-installation i normalt läge med en enda process. Köläge, flera arbetsprocesser och n8n Cloud stöds inte. n8n-nodens gränssnitt är på engelska.

1. Installera Frameleaf som communitynod och lägg till en autentiseringsuppgift av typen Frameleaf OAuth2 API.
2. Kopiera exakt OAuth Redirect URL. Be administratören för din Library att registrera den som en offentlig PKCE-klient med en betrodd HTTPS-återkopplingsadress.
3. Ange Library URL och det Client ID som administratören tillhandahåller. Välj den minsta behörighetsprofil du behöver och anslut.
4. Välj läsbara album och skrivmål separat. Anslut på nytt efter ändringar av adress eller behörigheter.

Direkt åtkomst via LAN eller egen HTTPS kräver ingen Frameleaf Cloud-plan. Relayåtkomst kräver en berättigad plan. Behåll certifikatkontroll och n8n:s nätverksskydd aktiverade; tillåt endast din Library vid behov.

Koppla Source ID till en stabil identitet från källhändelsen när du skapar album eller laddar upp filer. Uppladdningar kräver också en stabil Source Date. Behåll ID, datum, filnamn, innehåll och mål vid nya försök. Vänta den angivna tiden i Retry-After. Filer använder binärfält i n8n; nedladdningar har en inställbar storleksgräns.

Utlösare för nya foton, tillägg i album och Studio-exporter kommer i en senare version. Starta arbetsflöden med en annan utlösare tills dess, till exempel ett schema eller en webhook.

Återkalla åtkomsten i Frameleaf och ta bort autentiseringsuppgiften i n8n för att koppla från. Kopior som redan sparats på andra platser finns kvar. Kontakta support@frameleaf.app med åtgärd och HTTP-status, utan inloggningsuppgifter, privata filnamn eller medier.
