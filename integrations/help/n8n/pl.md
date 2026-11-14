# Łączenie Frameleaf z n8n

Używaj samodzielnie hostowanego n8n w trybie zwykłym, z jednym procesem. Tryb kolejki, wiele procesów roboczych oraz n8n Cloud nie są obsługiwane. Interfejs węzła n8n jest w języku angielskim.

1. Zainstaluj społecznościowy węzeł Frameleaf i dodaj poświadczenie Frameleaf OAuth2 API.
2. Skopiuj dokładny OAuth Redirect URL. Poproś administratora swojej Library o zarejestrowanie go jako publicznego klienta PKCE z zaufanym adresem zwrotnym HTTPS.
3. Wpisz Library URL oraz Client ID podany przez administratora. Wybierz najmniejszy potrzebny profil uprawnień i połącz się.
4. Osobno wybierz albumy do odczytu i miejsca zapisu. Po zmianie adresu lub uprawnień połącz się ponownie.

Bezpośredni dostęp przez LAN lub własny HTTPS nie wymaga planu Frameleaf Cloud. Dostęp przez przekaźnik wymaga odpowiedniego planu. Zachowaj włączoną weryfikację certyfikatów i ochronę sieciową n8n; w razie potrzeby zezwól wyłącznie na dostęp do swojej Library.

Przy tworzeniu albumów i przesyłaniu plików przypisz Source ID do stałego identyfikatora zdarzenia źródłowego. Przesyłanie wymaga też stałej Source Date. Przy ponawianiu zachowaj ID, datę, nazwę pliku, zawartość i miejsce docelowe. Odczekaj wskazany czas Retry-After. Pliki korzystają z pól binarnych n8n; pobieranie ma konfigurowalny limit rozmiaru.

Wyzwalacze dla nowych zdjęć, dodań do albumów i eksportów ze Studio pojawią się w jednej z kolejnych wersji. Do tego czasu uruchamiaj przepływy innym wyzwalaczem, na przykład harmonogramem lub webhookiem.

Aby rozłączyć, cofnij dostęp w Frameleaf i usuń poświadczenie n8n. Kopie zapisane wcześniej w innych miejscach pozostają. Napisz na support@frameleaf.app, podając operację i status HTTP, bez poświadczeń, prywatnych nazw plików i multimediów.
