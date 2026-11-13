# Importowanie obrazów Frameleaf

1. Zainstaluj i aktywuj ZIP Frameleaf Connect w WordPress.
2. Jako administrator otwórz **Media → Frameleaf** i dodaj adres źródłowy HTTPS swojej Library. Zezwalaj na sieć prywatną tylko dla własnej Library. Jeśli automatyczna rejestracja jest wyłączona, zarejestruj dokładnie wyświetlony adres powrotny w Frameleaf Connect i wpisz identyfikator klienta.
3. Każdy redaktor wybiera **Połącz Frameleaf** i zezwala na odczyt wybranych albumów. Adres powrotny WordPress wymaga HTTPS z zaufanym certyfikatem.
4. W oknie mediów Gutenberg lub edytora klasycznego wybierz **Frameleaf**. Przeglądaj album lub wyszukaj obraz, zaakceptuj lokalną kopię i zaimportuj go. Zmień podpis i tekst alternatywny w kontrolkach WordPress.

Importowane obrazy JPEG, PNG i WebP stają się zwykłymi załącznikami WordPress z widocznością witryny. Pozostają po rozłączeniu lub cofnięciu dostępu. Nie ma synchronizacji ani usuwania w tle. Ponowny import pobiera bieżącą wersję i porównuje SHA-256: identyczna zawartość używa tego samego załącznika, zmieniona tworzy nową kopię.

Serwer WordPress musi mieć dostęp do Library i ufać certyfikatowi. Lokalny lub własny HTTPS nie wymaga planu Frameleaf Cloud; przekaźnik Frameleaf wymaga dotychczasowego planu. Pliki muszą mieścić się w limicie WordPress i limicie wtyczki 16 MiB / 40 megapikseli.

Przy braku połączenia sprawdź adres i certyfikat, a następnie połącz ponownie. Niepewne odnowienie tokenu wymaga ponownego połączenia. Rozłączenie ponawia cofnięcie dostępu i zachowuje zaszyfrowane dane do powodzenia. Po zmianie kluczy lub soli WordPress cofnij dostęp w Frameleaf, potwierdź tutaj i wybierz **Zresetuj po zmianie kluczy WordPress**.

Nieudany import usuwa dane tymczasowe. Przerwana publikacja z niepewnym potwierdzeniem blokuje automatyczne duplikaty. Poproś administratora o sprawdzenie lokalnego załącznika i oczekującego rekordu `frameleaf_imports` przed odzyskaniem. Nigdy nie usuwaj takich rekordów bez sprawdzenia. Pomoc: support@frameleaf.app.

Frameleaf wymaga PHP cURL z obsługą HTTPS oraz bezpośredniej trasy sieciowej do Library. Żądania do Library nie korzystają z serwerów proxy HTTP.
