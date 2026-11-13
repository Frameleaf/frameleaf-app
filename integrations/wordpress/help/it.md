# Importare immagini Frameleaf

1. Installa e attiva il file ZIP Frameleaf Connect in WordPress.
2. Come amministratore, apri **Media → Frameleaf** e aggiungi l’origine HTTPS della tua Library. Consenti la rete privata solo per la tua Library. Se la registrazione automatica è disattivata, registra l’esatto indirizzo di ritorno mostrato in Frameleaf Connect e inserisci l’ID client.
3. Ogni redattore sceglie **Connetti Frameleaf** e autorizza gli album selezionati. L’indirizzo di ritorno WordPress richiede HTTPS con un certificato attendibile.
4. Nel selettore multimediale di Gutenberg o dell’editor classico, scegli **Frameleaf**. Sfoglia un album o cerca, accetta la copia locale e importa l’immagine. Modifica didascalia e testo alternativo con i controlli WordPress.

Le immagini JPEG, PNG e WebP importate diventano normali allegati WordPress con la visibilità del sito. Rimangono dopo la disconnessione o la revoca. Non sono previste sincronizzazioni o eliminazioni in background. Un nuovo import scarica la versione attuale per confrontare SHA-256: contenuti identici riutilizzano l’allegato; contenuti modificati creano una nuova copia.

Il server WordPress deve raggiungere la Library e riconoscerne il certificato. HTTPS locale o fornito dal cliente non richiede un piano Frameleaf Cloud; il relay Frameleaf richiede il piano previsto. I file devono rispettare il limite WordPress e quello del plugin di 16 MiB / 40 megapixel.

Se la connessione non funziona, verifica indirizzo e certificato e riconnettiti. Un rinnovo incerto richiede una nuova connessione. La disconnessione ritenta la revoca e conserva le credenziali cifrate fino al successo. Dopo modifiche alle chiavi o ai salt WordPress, revoca l’accesso in Frameleaf, confermalo qui e scegli **Reimposta dopo una modifica delle chiavi WordPress**.

Gli import falliti rimuovono i dati temporanei. Una pubblicazione interrotta con ricevuta incerta blocca i duplicati automatici. Chiedi all’amministratore di verificare l’allegato locale e il record `frameleaf_imports` in sospeso prima del recupero. Non cancellare mai record in sospeso senza verifica. Assistenza: support@frameleaf.app.

Frameleaf richiede PHP cURL con supporto HTTPS e un percorso di rete diretto alla Library. Le richieste alla Library non usano proxy HTTP.
