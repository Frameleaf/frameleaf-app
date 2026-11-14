# Korzystanie z Frameleaf w Raycast

1. Zainstaluj rozszerzenie Frameleaf w Raycast i otwórz **Search Photos** lub **Browse Albums**.
2. Wpisz adres swojej Library, na przykład `https://photos.example.com`. Zwykły HTTP działa tylko dla adresów w Twojej sieci, takich jak `http://192.168.1.20:2283`; logowanie i zdjęcia są wtedy przesyłane w tej sieci bez szyfrowania.
3. Zaloguj się do swojej Library w przeglądarce i wybierz albumy, które Raycast może odczytywać, albo zezwól na dostęp do całej biblioteki. Wróć do Raycast.

Wybierz zdjęcie, aby zobaczyć podgląd. W panelu akcji możesz otworzyć je w aplikacji Frameleaf, skopiować obraz lub link albo je pobrać. Pobrane pliki to duże pliki JPEG bez lokalizacji i danych aparatu; nigdy nie zastępują istniejącego pliku.

Aby pobierać oryginały, włącz **Original downloads** w preferencjach rozszerzenia. Przy następnym połączeniu Twoja Library poprosi o zgodę; na dowolnym zdjęciu wybierz **Allow Original Downloads**, aby połączyć się ponownie. Oryginały zachowują lokalizację i dane aparatu.

Połączenie bezpośrednie nie wymaga planu Frameleaf Cloud; przekaźnik Frameleaf podlega Twojemu planowi Cloud. Jeśli Twoja Library nie pozwala aplikacjom rejestrować się samodzielnie, poproś administratora o zarejestrowanie adresu powrotu `https://raycast.com/redirect?packageName=Extension` i wpisz identyfikator klienta w preferencjach rozszerzenia.

Raycast nie widzi osób, miejsc, udostępnień ani innych albumów i nie może niczego zmieniać ani usuwać. Albumy zmienisz w sekcji **Połączone aplikacje** w ustawieniach swojej Library. **Disconnect Library** cofa dostęp; jeśli Twoja Library jest nieosiągalna, Raycast zachowuje logowanie, aby można było spróbować ponownie. Pobrane już zdjęcia pozostają na komputerze.
