# Aus Lightroom Classic veröffentlichen

1. Lade die ZIP-Datei des Frameleaf-Plugins herunter, entpacke sie und wähle in Lightroom Classic **Datei → Zusatzmodul-Manager → Hinzufügen**. Wähle `frameleaf.lrplugin` aus.
2. Klicke im Bereich **Veröffentlichungsdienste** neben Frameleaf auf **Einrichten**. Gib die Adresse deiner Bibliothek ein, zum Beispiel `https://photos.example.com` oder `http://192.168.1.20:2283`. Lass **App-ID** leer, es sei denn, dein Administrator hat Lightroom für dich registriert.
3. Klicke auf **Verbinden…**. Dein Browser öffnet Frameleaf. Melde dich an, wähle die Alben, zu denen Lightroom Fotos hinzufügen darf, und erlaube das Erstellen neuer Alben, wenn jede Sammlung ein eigenes Album bekommen soll. Sobald der Browser zu Lightroom zurückkehrt, zeigt der Dialog **Verbunden** an.
4. Erstelle eine veröffentlichte Sammlung. Wähle in ihren Einstellungen ein vorhandenes Frameleaf-Album aus oder lass **Neues Album erstellen** stehen. Ziehe Fotos hinein und klicke auf **Veröffentlichen**.

Lightroom sendet sRGB-JPEGs mit Titel, Beschriftung, Stichwörtern und Urheberrecht. Der Standort wird entfernt, außer du aktivierst **Standort einschließen**, und Personen-Tags werden nie gesendet. Aktiviere **Lightroom-Stichwörter als Frameleaf-Tags hinzufügen** vor dem Verbinden, damit die Fotos auch in Frameleaf getaggt werden.

Frameleaf behält jede Kopie, die du veröffentlichst. Wenn du ein bearbeitetes Foto erneut veröffentlichst, wird neben der früheren Kopie eine neue hinzugefügt. Wenn du in Lightroom ein Foto oder eine Sammlung entfernst, wird nie etwas aus Frameleaf entfernt.

Für das Verbinden in deinem Heimnetzwerk oder über deine eigene HTTPS-Adresse brauchst du keinen Frameleaf-Cloud-Tarif. Für das Verbinden über das Frameleaf-Relay brauchst du einen Tarif mit Fernzugriff.

Wenn Lightroom meldet, dass die Verbindung beendet wurde, öffne die Einstellungen des Veröffentlichungsdienstes und klicke erneut auf **Verbinden…**. **Trennen** meldet Lightroom ab und entzieht ihm den Zugriff in Frameleaf. Du kannst Lightroom auch in Frameleaf unter **Einstellungen › Deine Anmeldung und Privatsphäre › Verbundene Apps** entfernen.
