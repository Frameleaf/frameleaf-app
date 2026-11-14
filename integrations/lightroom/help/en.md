# Publish from Lightroom Classic

1. Download the Frameleaf plugin ZIP, unzip it, and in Lightroom Classic choose **File → Plug-in Manager → Add**. Select `frameleaf.lrplugin`.
2. In the **Publish Services** panel, click **Set Up** next to Frameleaf. Enter your Library address, for example `https://photos.example.com` or `http://192.168.1.20:2283`. Leave **App ID** empty unless your administrator registered Lightroom for you.
3. Click **Connect…**. Your browser opens Frameleaf. Sign in, choose the albums Lightroom may add photos to, and allow creating new albums if you want each collection to get its own album. When the browser hands back to Lightroom, the dialog shows **Connected**.
4. Create a published collection. In its settings, pick an existing Frameleaf album or leave **Create a new album**. Drag photos in and click **Publish**.

Lightroom sends sRGB JPEGs with their title, caption, keywords and copyright. Location is removed unless you tick **Include location**, and people tags are never sent. Tick **Add Lightroom keywords as Frameleaf tags** before connecting to also tag photos in Frameleaf.

Frameleaf keeps every copy you publish. Republishing an edited photo adds a new copy next to the earlier one. Removing a photo or a collection in Lightroom never removes anything from Frameleaf.

Connecting on your home network or your own HTTPS address needs no Frameleaf Cloud plan. Connecting through Frameleaf relay needs a plan that includes remote access.

If Lightroom says the connection ended, open the publish service settings and click **Connect…** again. **Disconnect** signs Lightroom out and removes its access in Frameleaf; you can also remove Lightroom in Frameleaf under **Settings › Your sign-in & privacy › Connected apps**.
