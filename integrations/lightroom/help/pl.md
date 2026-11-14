# Publikowanie z Lightroom Classic

1. Pobierz plik ZIP wtyczki Frameleaf, rozpakuj go i w Lightroom Classic wybierz **File → Plug-in Manager → Add**. Wskaż `frameleaf.lrplugin`.
2. W panelu **Publish Services** kliknij **Set Up** obok Frameleaf. Wpisz adres swojej biblioteki, na przykład `https://photos.example.com` lub `http://192.168.1.20:2283`. Pole **Identyfikator aplikacji** zostaw puste, chyba że administrator zarejestrował Lightroom dla Ciebie.
3. Kliknij **Połącz…**. Przeglądarka otworzy Frameleaf. Zaloguj się, wybierz albumy, do których Lightroom może dodawać zdjęcia, i zezwól na tworzenie nowych albumów, jeśli chcesz, aby każda kolekcja miała własny album. Gdy przeglądarka wróci do Lightroom, w oknie pojawi się komunikat **Połączono**.
4. Utwórz opublikowaną kolekcję. W jej ustawieniach wybierz istniejący album Frameleaf albo zostaw **Utwórz nowy album**. Przeciągnij zdjęcia i kliknij **Publish**.

Lightroom wysyła pliki JPEG w sRGB z tytułem, opisem, słowami kluczowymi i prawami autorskimi. Lokalizacja jest usuwana, chyba że zaznaczysz **Dołącz lokalizację**, a etykiety osób nigdy nie są wysyłane. Zaznacz **Dodaj słowa kluczowe Lightroom jako etykiety Frameleaf** przed połączeniem, aby zdjęcia były też oznaczane etykietami we Frameleaf.

Frameleaf zachowuje każdą publikowaną kopię. Ponowne opublikowanie edytowanego zdjęcia dodaje nową kopię obok poprzedniej. Usunięcie zdjęcia lub kolekcji w Lightroom nigdy niczego nie usuwa z Frameleaf.

Połączenie w sieci domowej lub przez Twój własny adres HTTPS nie wymaga planu Frameleaf Cloud. Połączenie przez przekaźnik Frameleaf wymaga planu obejmującego dostęp zdalny.

Jeśli Lightroom pokaże, że połączenie zostało zakończone, otwórz ustawienia usługi publikowania i ponownie kliknij **Połącz…**. **Rozłącz** wylogowuje Lightroom i odbiera mu dostęp w Frameleaf; możesz też usunąć Lightroom w Frameleaf w sekcji **Ustawienia › Twoje logowanie i prywatność › Połączone aplikacje**.
