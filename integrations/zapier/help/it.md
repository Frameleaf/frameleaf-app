# Frameleaf Connect per Zapier

Beta privata. Trigger, ricerche, azioni e file sono implementati; sono ancora necessarie la qualifica ospitata e la revisione di Zapier. Non pubblicare questo pacchetto.

La connessione richiede library:read, library:download, albums:write, tags:write, photos:upload, boards:upload ed events:read. Nel consenso di Frameleaf, scegli gli album di tua proprietà da leggere e gli album o le aree di lavoro in cui scrivere. La lettura dell’intera Library è una scelta esplicita. Persone, condivisione, rimozione ed eliminazione non vengono mai richieste.

Zapier deve raggiungere un indirizzo HTTPS pubblico della Library. Il proprio HTTPS non richiede un piano Frameleaf Cloud; il relay Frameleaf richiede un piano idoneo. Abbonamenti e limiti Zapier sono separati. L’accesso solo LAN non è supportato.

Ottieni in Zapier l’indirizzo di ritorno esatto di questa applicazione privata. Un amministratore Frameleaf lo registra in Connect e fornisce l’ID client non segreto. Inserisci l’origine canonica del server e l’ID, quindi autorizza nel browser. Non incollare mai token nei campi di uno Zap.

I trigger degli eventi controllano i 1000 eventi corrispondenti più recenti a ogni polling. Se tra due polling ci sono più di 1000 eventi, i più vecchi vengono omessi; non è una sincronizzazione senza perdite.

Le azioni che creano qualcosa richiedono un ID origine che resti invariato per lo stesso elemento, come l’ID del passaggio precedente. Ripetizioni, nuovi tentativi ed esecuzioni simultanee creano così un solo album o file, senza duplicati.

I file vengono recuperati solo quando un passaggio successivo li usa, con l’accesso attuale della connessione. Revocare l’accesso nelle applicazioni connesse di Frameleaf blocca i file successivi; non può rimuovere le copie già inviate altrove. Rimuovere la connessione Zapier non revoca l’autorizzazione Frameleaf.

Prima della pubblicazione, qualifica l’app ospitata: OAuth nel browser con il vero callback, più Zap simultanei che condividono un’unica connessione in scadenza e producono una sola rotazione sicura, una risposta di aggiornamento persa, la revoca, e ogni trigger, ricerca, azione e file su una Library di prova.
