# Frameleaf Connect für Zapier

Nur die Verbindungsgrundlage ist enthalten. Aktionen, Suchen, Dateien und Auslöser sind noch nicht verfügbar. Dieses Paket darf noch nicht veröffentlicht oder produktiv verwendet werden.

Diese Prüfverbindung fordert nur library:read an. Wähle beim Frameleaf-Zugriff deine eigenen Alben einzeln aus; das Lesen der gesamten Mediathek erfordert eine ausdrückliche Auswahl. Originale, Personen und Schreibrechte werden nicht angefordert.

Zapier muss eine öffentliche HTTPS-Adresse der Library erreichen. Eigenes HTTPS erfordert keinen Frameleaf-Cloud-Tarif; das Frameleaf-Relay benötigt einen berechtigten Tarif. Zapier-Abonnements und Nutzungslimits sind getrennt. Reiner LAN-Zugriff wird nicht unterstützt.

Lass dir in Zapier die exakte Rückrufadresse dieser privaten Anwendung anzeigen. Ein Frameleaf-Administrator trägt sie in Connect ein und stellt die nicht geheime Client-ID bereit. Gib den kanonischen Serverursprung und die ID ein und bestätige den Zugriff im Browser. Füge niemals Tokens in Zap-Felder ein.

Gehostetes OAuth und gleichzeitige Erneuerungen müssen vor weiteren Funktionen geprüft werden. Mehrere Zaps mit derselben Verbindung müssen genau eine sichere Rotation auslösen, alle neuen Tokens speichern, Zugangsdaten bei unklaren Antworten behalten und den Zugriff korrekt widerrufen. Dieser Quellcode belegt diese Plattformfunktionen nicht.
