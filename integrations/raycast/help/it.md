# Usare Frameleaf in Raycast

1. Installa l’estensione Frameleaf in Raycast e apri **Search Photos** o **Browse Albums**.
2. Inserisci l’indirizzo della tua Library, ad esempio `https://photos.example.com`. L’HTTP semplice funziona solo per indirizzi della tua rete, come `http://192.168.1.20:2283`; in quel caso accesso e foto viaggiano non cifrati su quella rete.
3. Accedi alla tua Library nel browser e scegli gli album che Raycast può leggere, oppure consenti l’intera libreria. Torna a Raycast.

Seleziona una foto per vederne l’anteprima. Dal pannello delle azioni puoi aprirla in Frameleaf, copiare l’immagine o il suo link, oppure scaricarla. I download sono JPEG di grandi dimensioni senza posizione né dati della fotocamera e non sostituiscono mai un file esistente.

Per scaricare gli originali, attiva **Original downloads** nelle preferenze dell’estensione. La tua Library ti chiederà il consenso alla prossima connessione; su qualsiasi foto, scegli **Allow Original Downloads** per riconnetterti. Gli originali mantengono la posizione e i dati della fotocamera.

Una connessione diretta non richiede un piano Frameleaf Cloud; il relay di Frameleaf segue il tuo piano Cloud. Se la tua Library non consente alle app di registrarsi da sole, chiedi all’amministratore di registrare l’indirizzo di ritorno `https://raycast.com/redirect?packageName=Extension` e inserisci l’ID client nelle preferenze dell’estensione.

Raycast non vede persone, luoghi, condivisioni o altri album e non può modificare o eliminare nulla. Modifica i suoi album in **App collegate**, nelle impostazioni della tua Library. **Disconnect Library** revoca l’accesso; se la tua Library non è raggiungibile, Raycast mantiene l’accesso così puoi riprovare. Le foto già scaricate restano sul tuo computer.
