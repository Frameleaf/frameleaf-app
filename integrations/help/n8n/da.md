# Forbind Frameleaf med n8n

Brug en selvhostet n8n-installation i normal tilstand med én proces. Køtilstand, flere arbejdsprocesser og n8n Cloud understøttes ikke. n8n-nodens brugerflade er på engelsk.

1. Installer Frameleaf som communitynode, og tilføj en legitimationsoplysning af typen Frameleaf OAuth2 API.
2. Kopiér den præcise OAuth Redirect URL. Bed administratoren af din Library om at registrere den som en offentlig PKCE-klient med en betroet HTTPS-returadresse.
3. Indtast Library URL og det Client ID, administratoren har givet dig. Vælg den mindst omfattende tilladelsesprofil, du har brug for, og opret forbindelse.
4. Vælg læsbare album og skrivemål hver for sig. Opret forbindelsen igen efter ændringer af adresse eller tilladelser.

Direkte adgang via LAN eller egen HTTPS kræver ingen Frameleaf Cloud-plan. Relayadgang kræver en berettiget plan. Hold certifikatkontrol og n8n-netværksbeskyttelse aktiveret; tillad kun din Library, når det er nødvendigt.

Knyt Source ID til en stabil identitet fra kildehændelsen ved oprettelse af album og upload. Upload kræver også en stabil Source Date. Behold ID, dato, filnavn, indhold og destination ved nye forsøg. Vent den viste Retry-After-periode. Filer bruger binære felter i n8n; downloads har en justerbar størrelsesgrænse.

Udløsere for nye fotos, tilføjelser til albums og Studio-eksporter kommer i en senere version. Indtil da kan du starte workflows med en anden udløser, f.eks. en tidsplan eller en webhook.

Tilbagekald adgangen i Frameleaf, og slet legitimationsoplysningen i n8n for at afbryde forbindelsen. Kopier, der allerede er gemt andre steder, bevares. Kontakt support@frameleaf.app med handling og HTTP-status, uden legitimationsoplysninger, private filnavne eller medier.
