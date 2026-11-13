# Frameleaf Connect per Zapier

È presente solo la base di connessione. Azioni, ricerche, file e attivatori non sono ancora disponibili. Non pubblicare questo pacchetto né usarlo in produzione.

Questa connessione di verifica richiede solo library:read. Scegli esattamente i tuoi album nel consenso Frameleaf; la lettura dell’intera raccolta richiede una scelta esplicita. Non vengono richiesti originali, persone o scrittura.

Zapier deve raggiungere un indirizzo HTTPS pubblico della Library. Il proprio HTTPS non richiede un piano Frameleaf Cloud; il relay Frameleaf richiede un piano idoneo. Abbonamenti e limiti Zapier sono separati. L’accesso solo LAN non è supportato.

Ottieni in Zapier l’indirizzo di ritorno esatto di questa applicazione privata. Un amministratore Frameleaf lo registra in Connect e fornisce l’ID client non segreto. Inserisci l’origine canonica del server e l’ID, quindi autorizza nel browser. Non incollare mai token nei campi di uno Zap.

OAuth ospitato e rinnovi simultanei vanno verificati prima di aggiungere funzioni. Verifica che più Zaps con una connessione condivisa eseguano una sola rotazione sicura, salvino tutti i nuovi token, conservino le credenziali dopo una risposta incerta e revochino correttamente. Queste sorgenti non dimostrano tali comportamenti della piattaforma.
