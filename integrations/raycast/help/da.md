# Brug Frameleaf i Raycast

1. Installer Frameleaf-udvidelsen i Raycast, og åbn **Search Photos** eller **Browse Albums**.
2. Angiv adressen på dit Library, for eksempel `https://photos.example.com`. Almindelig HTTP virker kun for adresser på dit eget netværk, såsom `http://192.168.1.20:2283`; login og billeder sendes så ukrypteret på det netværk.
3. Log ind på dit Library i browseren, og vælg de albummer, Raycast må læse, eller giv adgang til hele dit bibliotek. Vend tilbage til Raycast.

Vælg et billede for at se en forhåndsvisning. Fra handlingspanelet kan du åbne det i Frameleaf, kopiere billedet eller dets link eller downloade det. Downloads er store JPEG-filer uden placering og kameraoplysninger og erstatter aldrig en eksisterende fil.

For at downloade originaler skal du slå **Original downloads** til i udvidelsens indstillinger. Dit Library beder dig om at tillade det, næste gang du forbinder; vælg **Allow Original Downloads** på et vilkårligt billede for at forbinde igen. Originaler beholder placering og kameraoplysninger.

En direkte forbindelse kræver ikke et Frameleaf Cloud-abonnement; Frameleaf-relay følger dit Cloud-abonnement. Hvis dit Library ikke lader apps registrere sig selv, så bed administratoren om at registrere returadressen `https://raycast.com/redirect?packageName=Extension`, og angiv klient-id’et i udvidelsens indstillinger.

Raycast kan ikke se personer, placeringer, deling eller andre albummer og kan ikke ændre eller slette noget. Skift albummerne under **Forbundne apps** i indstillingerne i dit Library. **Disconnect Library** tilbagekalder adgangen; hvis dit Library ikke kan nås, beholder Raycast sit login, så du kan prøve igen. Billeder, du allerede har downloadet, bliver på din computer.
