# Frameleaf mit n8n verbinden

Verwenden Sie selbst gehostetes n8n im regulären Modus mit einem einzigen Prozess. Warteschlangenmodus, mehrere Worker und n8n Cloud werden nicht unterstützt. Die Oberfläche des n8n-Knotens ist auf Englisch.

1. Installieren Sie den Frameleaf-Community-Knoten und legen Sie Zugangsdaten vom Typ Frameleaf OAuth2 API an.
2. Kopieren Sie die genaue OAuth Redirect URL. Lassen Sie diese vom Administrator Ihrer Library als öffentlichen PKCE-Client mit vertrauenswürdigem HTTPS-Rückruf registrieren.
3. Geben Sie Library URL und die bereitgestellte Client ID ein. Wählen Sie das kleinstmögliche Berechtigungsprofil und stellen Sie die Verbindung her.
4. Wählen Sie lesbare Alben und Schreibziele getrennt aus. Verbinden Sie sich nach Änderungen an Adresse oder Berechtigungen erneut.

Direkter LAN-Zugriff oder eigenes HTTPS benötigt keinen Frameleaf Cloud-Tarif. Der Relay-Zugriff erfordert einen geeigneten Tarif. Lassen Sie Zertifikatsprüfung und Netzwerkschutz von n8n aktiviert; geben Sie bei Bedarf nur Ihre Library frei.

Ordnen Sie Source ID beim Erstellen von Alben und beim Hochladen einer stabilen Kennung des Quellereignisses zu. Uploads benötigen außerdem eine gleichbleibende Source Date. Behalten Sie ID, Datum, Dateiname, Inhalt und Ziel bei Wiederholungen bei. Warten Sie die angezeigte Retry-After-Frist ab. Dateien verwenden Binärfelder von n8n; Downloads haben eine einstellbare Größenbegrenzung.

Trigger für neue Fotos, Albumergänzungen und Studio-Exporte folgen in einer späteren Version. Starten Sie Workflows bis dahin mit einem anderen Trigger, etwa einem Zeitplan oder einem Webhook.

Widerrufen Sie zum Trennen den Zugriff in Frameleaf und löschen Sie die n8n-Zugangsdaten. Bereits andernorts gespeicherte Kopien bleiben erhalten. Senden Sie support@frameleaf.app den Vorgang und HTTP-Status, jedoch keine Zugangsdaten, privaten Dateinamen oder Medien.
