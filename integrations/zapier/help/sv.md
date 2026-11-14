# Frameleaf Connect för Zapier

Privat beta. Utlösare, sökningar, åtgärder och filer är implementerade; värdbaserad kvalificering och Zapier-granskning krävs fortfarande. Publicera inte det här paketet.

Anslutningen begär library:read, library:download, albums:write, tags:write, photos:upload, boards:upload och events:read. Välj vid samtycket i Frameleaf exakt vilka egna album som får läsas och vilka album eller arbetsytor som får skrivas till. Att läsa hela Library är ett uttryckligt val. Personer, delning, borttagning och radering begärs aldrig.

Zapier måste kunna nå en offentlig HTTPS-adress för Library. Egen HTTPS kräver ingen Frameleaf Cloud-plan; Frameleaf-relä kräver en giltig plan. Zapier-abonnemang och användningsgränser är separata. Enbart LAN-åtkomst stöds inte.

Hämta den exakta returadressen för den privata appen i Zapier. En Frameleaf-administratör registrerar den i Connect och lämnar ett icke-hemligt klient-ID. Ange serverns kanoniska ursprung och ID och ge samtycke i webbläsaren. Klistra aldrig in tokens i ett Zap-fält.

Händelseutlösare kontrollerar de 1000 senaste matchande händelserna vid varje avfrågning. Om fler än 1000 händelser inträffar mellan två avfrågningar utelämnas de äldsta; det är ingen förlustfri synkronisering.

Åtgärder som skapar något kräver ett käll-ID som förblir detsamma för samma objekt, till exempel ID:t från föregående steg. Omkörningar, nya försök och samtidiga körningar skapar då ett enda album eller en enda fil, inga dubbletter.

Filer hämtas först när ett senare steg använder dem, med anslutningens aktuella åtkomst. Att återkalla åtkomsten i Frameleafs anslutna appar stoppar fler filer; det kan inte ta bort kopior som redan skickats någon annanstans. Att ta bort Zapier-anslutningen återkallar inte Frameleaf-behörigheten.

Kvalificera den värdbaserade appen före publicering: OAuth i webbläsaren med den riktiga återanropsadressen, flera samtidiga Zaps som delar en utgående anslutning och ger en enda säker rotation, ett förlorat uppdateringssvar, återkallning samt varje utlösare, sökning, åtgärd och fil mot en test-Library.
