# Frameleaf Connect für Zapier

Private Beta. Trigger, Suchen, Aktionen und Dateien sind implementiert; die gehostete Qualifizierung und die Zapier-Prüfung stehen noch aus. Dieses Paket nicht veröffentlichen.

Die Verbindung fordert library:read, library:download, albums:write, tags:write, photos:upload, boards:upload und events:read an. Wähle bei der Zustimmung in Frameleaf die genauen eigenen Alben zum Lesen sowie die Alben oder Arbeitsbereiche zum Schreiben aus. Das Lesen der gesamten Library ist eine ausdrückliche Entscheidung. Personen, Freigaben, Entfernen und Löschen werden nie angefordert.

Zapier muss eine öffentliche HTTPS-Adresse der Library erreichen. Eigenes HTTPS erfordert keinen Frameleaf-Cloud-Tarif; das Frameleaf-Relay benötigt einen berechtigten Tarif. Zapier-Abonnements und Nutzungslimits sind getrennt. Reiner LAN-Zugriff wird nicht unterstützt.

Lass dir in Zapier die exakte Rückrufadresse dieser privaten Anwendung anzeigen. Ein Frameleaf-Administrator trägt sie in Connect ein und stellt die nicht geheime Client-ID bereit. Gib den kanonischen Serverursprung und die ID ein und bestätige den Zugriff im Browser. Füge niemals Tokens in Zap-Felder ein.

Ereignis-Trigger prüfen bei jeder Abfrage die neuesten 1000 passenden Ereignisse. Bei mehr als 1000 Ereignissen zwischen zwei Abfragen werden die ältesten ausgelassen; das ist keine verlustfreie Synchronisierung.

Aktionen, die etwas erstellen, benötigen eine Quell-ID, die für dasselbe Element gleich bleibt, etwa die ID aus dem vorherigen Schritt. Wiederholungen, erneute Versuche und gleichzeitige Ausführungen erzeugen dann nur ein Album bzw. eine Datei, keine Duplikate.

Dateien werden erst abgerufen, wenn ein späterer Schritt sie verwendet, und zwar mit dem aktuellen Zugriff der Verbindung. Das Widerrufen des Zugriffs in den verbundenen Apps von Frameleaf stoppt weitere Dateien; bereits anderswohin gesendete Kopien lassen sich nicht entfernen. Das Entfernen der Zapier-Verbindung widerruft die Frameleaf-Freigabe nicht.

Qualifiziere die gehostete App vor der Veröffentlichung: Browser-OAuth mit dem echten Rückruf, mehrere gleichzeitige Zaps mit einer gemeinsamen ablaufenden Verbindung, die genau eine sichere Rotation auslösen, eine verlorene Aktualisierungsantwort, den Widerruf sowie jeden Trigger, jede Suche, Aktion und Datei mit einer Test-Library.
