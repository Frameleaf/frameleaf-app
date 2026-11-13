# Frameleaf-Bilder importieren

1. Installiere und aktiviere die ZIP-Datei Frameleaf Connect in WordPress.
2. Öffne als Administrator **Medien → Frameleaf** und füge die HTTPS-Origin deiner Library hinzu. Erlaube private Netzwerke nur für deine eigene Library. Bei deaktivierter automatischer Registrierung registrierst du die genau angezeigte Rückrufadresse in Frameleaf Connect und trägst die Client-ID ein.
3. Jeder Redakteur wählt **Frameleaf verbinden** und erlaubt die ausgewählten Alben. Die WordPress-Rückrufadresse benötigt HTTPS mit einem vertrauenswürdigen Zertifikat.
4. Wähle im Medienfenster von Gutenberg oder dem klassischen Editor **Frameleaf**. Durchsuche ein Album oder suche, bestätige die lokale Kopie und importiere das Bild. Bearbeite Bildunterschrift und Alternativtext mit den WordPress-Funktionen.

Importierte JPEG-, PNG- und WebP-Bilder werden normale WordPress-Anhänge mit der üblichen Sichtbarkeit der Website. Sie bleiben nach Trennung oder Widerruf erhalten. Es gibt keine Hintergrundsynchronisierung oder automatische Löschung. Ein erneuter Import lädt die aktuelle Darstellung zum SHA-256-Vergleich: identischer Inhalt verwendet den Anhang erneut, geänderter Inhalt erzeugt eine neue Kopie.

Der WordPress-Server muss die Library erreichen und ihrem Zertifikat vertrauen. Lokales oder kundeneigenes HTTPS benötigt keinen Frameleaf Cloud-Tarif; der Frameleaf-Relay benötigt seinen bestehenden Tarif. Dateien müssen die WordPress-Grenze und die Plugin-Grenze von 16 MiB / 40 Megapixeln einhalten.

Prüfe bei Verbindungsfehlern Adresse und Zertifikat und verbinde dich erneut. Eine ungewisse Token-Erneuerung erfordert eine neue Verbindung. Das Trennen wiederholt den Widerruf und bewahrt verschlüsselte Zugangsdaten bis zum Erfolg auf. Nach Änderungen der WordPress-Schlüssel oder Salts widerrufst du den Zugriff in Frameleaf, bestätigst dies hier und wählst **Nach einer Änderung der WordPress-Schlüssel zurücksetzen**.

Fehlgeschlagene Importe entfernen temporäre Daten. Eine unterbrochene Veröffentlichung mit ungewissem Beleg blockiert automatische Duplikate. Lass den Administrator den lokalen Anhang und den ausstehenden `frameleaf_imports`-Eintrag vor einer Wiederherstellung prüfen. Ausstehende Einträge niemals ungeprüft löschen. Support: support@frameleaf.app.

Frameleaf benötigt PHP cURL mit HTTPS-Unterstützung und einen direkten Netzwerkzugang zur Library. Für Library-Anfragen werden keine HTTP-Proxys verwendet.
