# Publicera från Lightroom Classic

1. Ladda ner ZIP-filen med Frameleaf-pluginet, packa upp den och välj **File → Plug-in Manager → Add** i Lightroom Classic. Välj `frameleaf.lrplugin`.
2. Klicka på **Set Up** bredvid Frameleaf i panelen **Publish Services**. Ange adressen till ditt bibliotek, till exempel `https://photos.example.com` eller `http://192.168.1.20:2283`. Lämna **App-ID** tomt om inte din administratör har registrerat Lightroom åt dig.
3. Klicka på **Anslut…**. Din webbläsare öppnar Frameleaf. Logga in, välj de album som Lightroom får lägga till foton i, och tillåt att nya album skapas om du vill att varje samling ska få ett eget album. När webbläsaren lämnar tillbaka till Lightroom visar dialogrutan **Ansluten**.
4. Skapa en publicerad samling. Välj ett befintligt Frameleaf-album i dess inställningar eller låt **Skapa ett nytt album** stå kvar. Dra in foton och klicka på **Publish**.

Lightroom skickar sRGB-JPEG-filer med titel, bildtext, nyckelord och upphovsrätt. Platsen tas bort om du inte kryssar i **Ta med plats**, och personetiketter skickas aldrig. Kryssa i **Lägg till Lightroom-nyckelord som Frameleaf-taggar** innan du ansluter om du också vill tagga fotona i Frameleaf.

Frameleaf behåller varje kopia du publicerar. Om du publicerar ett redigerat foto igen läggs en ny kopia till bredvid den tidigare. Att ta bort ett foto eller en samling i Lightroom tar aldrig bort något från Frameleaf.

Du behöver ingen Frameleaf Cloud-plan för att ansluta i ditt hemnätverk eller via din egen HTTPS-adress. Att ansluta via Frameleaf-relay kräver en plan som inkluderar fjärråtkomst.

Om Lightroom säger att anslutningen har avslutats öppnar du publiceringstjänstens inställningar och klickar på **Anslut…** igen. **Koppla från** loggar ut Lightroom och tar bort dess åtkomst i Frameleaf; du kan också ta bort Lightroom i Frameleaf under **Inställningar › Din inloggning och sekretess › Anslutna appar**.
