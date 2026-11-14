# Frameleaf Connect voor Zapier

Privébèta. Triggers, zoekacties, acties en bestanden zijn geïmplementeerd; gehoste kwalificatie en Zapier-review zijn nog vereist. Publiceer dit pakket niet.

De verbinding vraagt library:read, library:download, albums:write, tags:write, photos:upload, boards:upload en events:read aan. Kies bij de toestemming in Frameleaf de exacte eigen albums om te lezen en de albums of werkruimtes om naar te schrijven. De hele Library lezen is een expliciete keuze. Personen, delen, verwijderen en wissen worden nooit gevraagd.

Zapier moet een openbaar HTTPS-adres van de Library kunnen bereiken. Eigen HTTPS vereist geen Frameleaf Cloud-abonnement; voor de Frameleaf-relay is een geschikt abonnement nodig. Zapier-abonnementen en gebruikslimieten staan hier los van. Alleen LAN-toegang wordt niet ondersteund.

Vraag in Zapier de exacte terugkeer-URL van deze privé-app op. Een Frameleaf-beheerder registreert deze in Connect en geeft de niet-geheime client-ID. Voer de canonieke serveroorsprong en ID in en geef toestemming in de browser. Plak nooit tokens in Zap-velden.

Gebeurtenistriggers controleren bij elke poll de nieuwste 1000 overeenkomende gebeurtenissen. Bij meer dan 1000 gebeurtenissen tussen twee polls worden de oudste overgeslagen; dit is geen verliesvrije synchronisatie.

Acties die iets aanmaken vereisen een bron-ID dat voor hetzelfde item gelijk blijft, zoals het ID uit de vorige stap. Herhalingen, nieuwe pogingen en gelijktijdige runs maken dan één album of bestand aan, geen dubbelen.

Bestanden worden pas opgehaald wanneer een latere stap ze gebruikt, met de huidige toegang van de verbinding. Toegang intrekken bij de verbonden apps van Frameleaf stopt verdere bestanden; reeds elders verzonden kopieën kunnen niet worden verwijderd. Het verwijderen van de Zapier-verbinding trekt de Frameleaf-toestemming niet in.

Kwalificeer de gehoste app vóór publicatie: browser-OAuth met de echte callback, gelijktijdige Zaps die één verlopende verbinding delen en één veilige rotatie opleveren, een verloren vernieuwingsantwoord, intrekking, en elke trigger, zoekactie, actie en elk bestand met een test-Library.
