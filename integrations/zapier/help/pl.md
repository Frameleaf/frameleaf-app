# Frameleaf Connect dla Zapier

Prywatna wersja beta. Wyzwalacze, wyszukiwania, akcje i pliki są zaimplementowane; nadal wymagane są kwalifikacja hostowana i recenzja Zapier. Nie publikuj tego pakietu.

Połączenie żąda library:read, library:download, albums:write, tags:write, photos:upload, boards:upload i events:read. Podczas wyrażania zgody w Frameleaf wybierz dokładnie te własne albumy, które mają być odczytywane, oraz albumy lub obszary robocze, do których można zapisywać. Odczyt całej Library jest wyborem jawnym. Osoby, udostępnianie, usuwanie i kasowanie nigdy nie są żądane.

Zapier musi mieć dostęp do publicznego adresu HTTPS Library. Własny HTTPS nie wymaga planu Frameleaf Cloud; przekaźnik Frameleaf wymaga odpowiedniego planu. Subskrypcje i limity Zapier są osobne. Dostęp wyłącznie przez LAN nie jest obsługiwany.

Uzyskaj w Zapier dokładny adres powrotny tej prywatnej aplikacji. Administrator Frameleaf rejestruje go w Connect i przekazuje niepoufny identyfikator klienta. Wpisz kanoniczny adres źródła serwera i identyfikator, a następnie wyraź zgodę w przeglądarce. Nigdy nie wklejaj tokenów w pola Zap.

Wyzwalacze zdarzeń sprawdzają przy każdym odpytaniu 1000 najnowszych pasujących zdarzeń. Jeśli między dwoma odpytaniami wystąpi więcej niż 1000 zdarzeń, najstarsze są pomijane; nie jest to synchronizacja bez strat.

Akcje tworzące coś wymagają identyfikatora źródła, który pozostaje taki sam dla tego samego elementu, na przykład ID z poprzedniego kroku. Powtórzenia, ponowne próby i równoczesne uruchomienia utworzą wtedy jeden album lub plik, bez duplikatów.

Pliki są pobierane dopiero wtedy, gdy użyje ich późniejszy krok, z bieżącym dostępem połączenia. Cofnięcie dostępu w połączonych aplikacjach Frameleaf zatrzymuje dalsze pliki; nie usunie kopii już wysłanych gdzie indziej. Usunięcie połączenia Zapier nie cofa zgody w Frameleaf.

Przed publikacją zakwalifikuj hostowaną aplikację: OAuth w przeglądarce z prawdziwym adresem zwrotnym, równoczesne Zapy współdzielące jedno wygasające połączenie i wykonujące jedną bezpieczną rotację, utraconą odpowiedź odświeżenia, unieważnienie oraz każdy wyzwalacz, wyszukiwanie, akcję i plik na testowej Library.
