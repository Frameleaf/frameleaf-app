# Manual qualification

Run on Lightroom Classic 15 (or 13+) on macOS and on Windows, against a disposable Library with synthetic photos. Never use a customer Library. Record the Lightroom version, OS and Library version.

Setup: build the ZIP (`scripts/package.sh`), unzip, add `frameleaf.lrplugin` in **File → Plug-in Manager**. Check the version shown matches the repository version.

1. **Connect (LAN).** Set up the Frameleaf publish service with `http://<lan-ip>:2283`. Click **Connect…**. The browser opens the consent page; allow two existing albums for writing and allow creating albums. Lightroom shows "Lightroom is connected to Frameleaf." and the dialog shows **Connected to …**.
2. **Connect (HTTPS/relay).** Repeat with the Library's own HTTPS address and, for a subscriber, the relay address.
3. **Manual app ID.** On a Library with app registration turned off, Connect shows the "register Lightroom" message. Register the callback `lightroom://net.frameleaf.connect/oauth/callback` as an administrator, enter the app ID, connect.
4. **Denied consent.** Start connecting and deny on the consent page: Lightroom says access wasn't allowed and stays disconnected. Re-open the old browser callback URL: Lightroom says the sign-in expired.
5. **Publish 50.** Create a collection, leave **Create a new album**, add 50 photos with titles, captions, keywords, copyright and GPS. Publish. The album appears with 50 photos; title, caption and copyright show in the photo's info; location is absent; no people come across.
6. **Existing album.** Create a second collection, choose one of the allowed albums in its settings, publish 3 photos: they land in that album.
7. **Keywords as tags.** Disconnect, tick **Add Lightroom keywords as Frameleaf tags**, connect again, republish one photo: its keywords appear as tags. With the box ticked but tags not allowed at consent, publishing still succeeds and shows the keyword warning.
8. **Republish.** Edit one published photo and republish: Frameleaf has the new copy and still has the earlier one; nothing is duplicated for unchanged photos.
9. **Remove.** Remove a photo from the collection and publish; delete a whole collection. Lightroom says the photos stay in Frameleaf; the assets and album remain in Frameleaf.
10. **Interrupted export.** Publish 20 large photos and pull the network mid-way, then restore and publish again: unfinished photos resume or retry, finished photos are not duplicated.
11. **Cancel.** Cancel a publish in progress: no partial asset appears; the photo stays in **Modified Photos to Re-Publish**.
12. **Revoke.** Remove Lightroom under **Settings › Your sign-in & privacy › Connected apps**. Publishing shows "Your connection to Frameleaf has ended" and asks to connect again. **Disconnect** in Lightroom also removes it from Connected apps.
13. **Narrowed access.** In Connected apps, remove write access to the collection's album; publishing shows "This connection isn't allowed to do that".
14. **Wrong address.** Enter an address that isn't a Library: Connect says it isn't a Frameleaf Library.
15. **Secrets.** After all steps, search the Lightroom plug-in log (`Frameleaf.log` in Lightroom's logs folder) for `Bearer`, `access`, `refresh`, `code=`: none appear.
16. **Languages.** Switch Lightroom to German and to one more language: the publish dialog and messages are translated. Check Norwegian (`TranslatedStrings_nb.txt`) and Polish load on a Lightroom build that offers them.
