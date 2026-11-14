# Frameleaf in Raycast verwenden

1. Installieren Sie die Frameleaf-Erweiterung in Raycast und öffnen Sie **Search Photos** oder **Browse Albums**.
2. Geben Sie die Adresse Ihrer Library ein, zum Beispiel `https://photos.example.com`. Einfaches HTTP funktioniert nur für Adressen in Ihrem eigenen Netzwerk, etwa `http://192.168.1.20:2283`; Anmeldung und Fotos werden dann in diesem Netzwerk unverschlüsselt übertragen.
3. Melden Sie sich im Browser bei Ihrer Library an und wählen Sie die Alben, die Raycast lesen darf, oder erlauben Sie die gesamte Mediathek. Kehren Sie zu Raycast zurück.

Wählen Sie ein Foto aus, um eine Vorschau zu sehen. Im Aktionsmenü können Sie es in Frameleaf öffnen, das Bild oder seinen Link kopieren oder es herunterladen. Downloads sind große JPEG-Dateien ohne Standort- und Kameradaten und ersetzen nie eine vorhandene Datei.

Um Originale herunterzuladen, aktivieren Sie **Original downloads** in den Einstellungen der Erweiterung. Ihre Library bittet Sie bei der nächsten Verbindung um Zustimmung; wählen Sie bei einem beliebigen Foto **Allow Original Downloads**, um sich erneut zu verbinden. Originale behalten Standort- und Kameradaten.

Eine direkte Verbindung erfordert kein Frameleaf Cloud-Abo; das Frameleaf-Relay richtet sich nach Ihrem Cloud-Abo. Wenn sich in Ihrer Library keine Apps selbst registrieren dürfen, bitten Sie die Administration, die Rücksprungadresse `https://raycast.com/redirect?packageName=Extension` zu registrieren, und tragen Sie die Client-ID in den Einstellungen der Erweiterung ein.

Raycast sieht keine Personen, Orte, Freigaben oder anderen Alben und kann nichts ändern oder löschen. Die Alben ändern Sie unter **Verbundene Apps** in den Einstellungen Ihrer Library. **Disconnect Library** widerruft den Zugriff; ist Ihre Library nicht erreichbar, behält Raycast die Anmeldung, damit Sie es erneut versuchen können. Bereits heruntergeladene Fotos bleiben auf Ihrem Computer.
