# Frameleaf gebruiken in Raycast

1. Installeer de Frameleaf-extensie in Raycast en open **Search Photos** of **Browse Albums**.
2. Voer het adres van je Library in, bijvoorbeeld `https://photos.example.com`. Gewoon HTTP werkt alleen voor adressen op je eigen netwerk, zoals `http://192.168.1.20:2283`; inloggen en foto’s gaan dan onversleuteld over dat netwerk.
3. Log in bij je Library in de browser en kies de albums die Raycast mag lezen, of geef toegang tot je hele bibliotheek. Ga terug naar Raycast.

Selecteer een foto om een voorbeeld te zien. Vanuit het actiepaneel kun je de foto openen in Frameleaf, de afbeelding of de link kopiëren, of de foto downloaden. Downloads zijn grote JPEG-bestanden zonder locatie- en cameragegevens en vervangen nooit een bestaand bestand.

Om originelen te downloaden, zet je **Original downloads** aan in de voorkeuren van de extensie. Je Library vraagt je bij de volgende verbinding om toestemming; kies bij een willekeurige foto **Allow Original Downloads** om opnieuw te verbinden. Originelen behouden hun locatie- en cameragegevens.

Een directe verbinding vereist geen Frameleaf Cloud-abonnement; de Frameleaf-relay volgt je Cloud-abonnement. Als je Library apps niet toestaat zichzelf te registreren, vraag de beheerder dan het terugkeeradres `https://raycast.com/redirect?packageName=Extension` te registreren en voer de client-ID in bij de voorkeuren van de extensie.

Raycast ziet geen personen, locaties, gedeelde items of andere albums en kan niets wijzigen of verwijderen. Wijzig de albums bij **Verbonden apps** in de instellingen van je Library. **Disconnect Library** trekt de toegang in; als je Library niet bereikbaar is, bewaart Raycast de aanmelding zodat je het opnieuw kunt proberen. Foto’s die je al hebt gedownload, blijven op je computer.
