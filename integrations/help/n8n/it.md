# Collegare Frameleaf a n8n

Usa n8n su un server gestito da te, in modalità normale con un solo processo. La modalità coda, più worker e n8n Cloud non sono supportati. L’interfaccia del nodo n8n è in inglese.

1. Installa il nodo della comunità Frameleaf e aggiungi una credenziale Frameleaf OAuth2 API.
2. Copia esattamente OAuth Redirect URL. Chiedi all’amministratore della tua Library di registrarla come client pubblico PKCE con callback HTTPS attendibile.
3. Inserisci Library URL e il Client ID fornito dall’amministratore. Scegli il profilo minimo di autorizzazioni e connettiti.
4. Seleziona separatamente gli album leggibili e le destinazioni di scrittura. Riconnettiti dopo aver cambiato indirizzo o autorizzazioni.

L’accesso diretto via LAN o HTTPS proprio non richiede un piano Frameleaf Cloud. Il relay richiede un piano idoneo. Mantieni attive la verifica dei certificati e la protezione di rete di n8n; autorizza soltanto la tua Library quando necessario.

Per creare album e caricare file, associa Source ID a un identificatore stabile dell’evento originale. I caricamenti richiedono anche una Source Date stabile. Mantieni invariati ID, data, nome del file, contenuto e destinazione nei nuovi tentativi. Attendi il periodo Retry-After indicato. I file usano i campi binari di n8n; i download hanno un limite di dimensione configurabile.

I trigger per nuove foto, aggiunte agli album ed esportazioni di Studio arriveranno in una versione successiva. Nel frattempo, avvia i flussi di lavoro con un altro trigger, ad esempio una pianificazione o un webhook.

Per disconnettere, revoca l’accesso in Frameleaf ed elimina la credenziale n8n. Le copie già salvate altrove rimangono. Contatta support@frameleaf.app indicando operazione e stato HTTP, senza credenziali, nomi di file privati o contenuti multimediali.
