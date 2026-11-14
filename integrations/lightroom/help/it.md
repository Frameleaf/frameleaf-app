# Pubblicare da Lightroom Classic

1. Scarica lo ZIP del plugin Frameleaf, decomprimilo e, in Lightroom Classic, scegli **File → Gestione plug-in → Aggiungi**. Seleziona `frameleaf.lrplugin`.
2. Nel pannello **Servizi di pubblicazione**, fai clic su **Imposta** accanto a Frameleaf. Inserisci l’indirizzo della tua libreria, per esempio `https://photos.example.com` o `http://192.168.1.20:2283`. Lascia vuoto **ID app**, a meno che il tuo amministratore non abbia registrato Lightroom per te.
3. Fai clic su **Connetti…**. Il browser apre Frameleaf. Accedi, scegli gli album a cui Lightroom può aggiungere foto e consenti la creazione di nuovi album se vuoi che ogni raccolta abbia il suo album. Quando il browser torna a Lightroom, la finestra mostra **Connesso**.
4. Crea una raccolta pubblicata. Nelle sue impostazioni, scegli un album Frameleaf esistente oppure lascia **Crea un nuovo album**. Trascina le foto e fai clic su **Pubblica**.

Lightroom invia JPEG sRGB con titolo, didascalia, parole chiave e diritto d’autore. La posizione viene rimossa a meno che tu non selezioni **Includi la posizione**, e i tag delle persone non vengono mai inviati. Seleziona **Aggiungi le parole chiave di Lightroom come tag di Frameleaf** prima di connetterti per taggare le foto anche in Frameleaf.

Frameleaf conserva ogni copia che pubblichi. Ripubblicare una foto modificata aggiunge una nuova copia accanto a quella precedente. Rimuovere una foto o una raccolta in Lightroom non rimuove mai nulla da Frameleaf.

Connettersi dalla rete di casa o con il tuo indirizzo HTTPS non richiede un piano Frameleaf Cloud. Connettersi tramite il relay di Frameleaf richiede un piano che includa l’accesso remoto.

Se Lightroom dice che la connessione è terminata, apri le impostazioni del servizio di pubblicazione e fai di nuovo clic su **Connetti…**. **Disconnetti** scollega Lightroom e rimuove il suo accesso in Frameleaf; puoi anche rimuovere Lightroom in Frameleaf in **Impostazioni › Il tuo accesso e la privacy › App collegate**.
