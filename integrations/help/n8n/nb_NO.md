# Koble Frameleaf til n8n

Bruk en selvhostet n8n-installasjon i vanlig modus med én prosess. Kømodus, flere arbeidsprosesser og n8n Cloud støttes ikke. Brukergrensesnittet til n8n-noden er på engelsk.

1. Installer Frameleaf som fellesskapsnode, og legg til en påloggingsoppføring av typen Frameleaf OAuth2 API.
2. Kopier den nøyaktige OAuth Redirect URL. Be administratoren for din Library om å registrere den som en offentlig PKCE-klient med en betrodd HTTPS-returadresse.
3. Skriv inn Library URL og Client ID fra administratoren. Velg den minste tillatelsesprofilen du trenger, og koble til.
4. Velg lesbare album og skrivemål hver for seg. Koble til på nytt etter endringer i adressen eller tillatelsene.

Direkte tilgang via LAN eller egen HTTPS krever ingen Frameleaf Cloud-plan. Tilgang via relé krever en kvalifiserende plan. Behold sertifikatkontroll og nettverksbeskyttelsen i n8n aktivert; tillat bare din Library ved behov.

Knytt Source ID til en stabil identitet fra kildehendelsen når du oppretter album eller laster opp filer. Opplastinger krever også en stabil Source Date. Behold ID, dato, filnavn, innhold og mål ved nye forsøk. Vent den oppgitte Retry-After-tiden. Filer bruker binærfelt i n8n; nedlastinger har en justerbar størrelsesgrense.

Utløsere for nye bilder, tillegg i album og Studio-eksporter kommer i en senere versjon. Inntil da kan du starte arbeidsflyter med en annen utløser, for eksempel en tidsplan eller en webhook.

Tilbakekall tilgangen i Frameleaf og slett påloggingsoppføringen i n8n for å koble fra. Kopier som allerede er lagret andre steder, beholdes. Kontakt support@frameleaf.app med handling og HTTP-status, uten påloggingsopplysninger, private filnavn eller medier.
