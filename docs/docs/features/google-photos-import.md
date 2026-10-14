# Import Google Photos

**Import from Google Photos** brings a Google Takeout export into your library: the original files, the dates they were taken, descriptions, locations, favorites, archived photos, Locked Folder photos, Live Photos and album memberships. Open it from **Settings → Google Photos & server imports → Import from Google Photos…**, from the administrator's **Import & protection** settings, or by searching for it.

An import has three steps, **Upload**, **Check** and **Import**, and moves on by itself: you choose the ZIP files and press **Import** once.

:::tip Large libraries
Only the upload needs the page open. Once every file is uploaded, checking and importing run on the server, so with a large library you're free to close your browser and come back when the import is complete. Progress also shows in **Activity**.
:::

## Upload

Download every ZIP file of one Takeout export before you start, and choose them all at once. Google spreads a photo's details, such as its date, place and albums, across different ZIP files, so importing only some of them can leave photos without their details.

Each archive is uploaded in parts. If the upload stops (the browser closed, the network dropped), open the import again and choose the same files: it carries on where it stopped. Every part already on the server is compared with the file you chose before anything is added, so a different file with the same name is refused rather than mixed in.

An archive is refused when your storage quota or the server's free space could not hold it.

Administrators can import from a folder on the server instead of uploading, under **Import from a folder on this server**, but only from a folder inside one of the locations the server operator permitted with `FRAMELEAF_IMPORT_ROOTS`. Folders are read without following links, and never from the library's own storage.

## Check

The check starts as soon as the last file is uploaded. The server reads each archive and matches every photo and video with its details, including localized folder names, Google's shortened file names and details that ended up in a different archive of the same export. A photo and a video that share a name in the same folder are kept together as a Live Photo.

When Google sent two sets of details for one photo, Frameleaf chooses the most likely: the set whose title is the photo's own name, then the one with the most details.

Entries that could escape a folder (an unsafe name or a link), encrypted entries and damaged data are refused and counted, never staged.

## Import

When the check finishes, the import shows what it found: new photos and videos, photos already in your library, albums and Live Photos. Before you press **Import**, you can:

- turn off **Keep album memberships**, or choose which albums are made; Google's automatic year folders are never made into albums
- turn on **Fill in missing details on photos you already have**
- bring in the photos that were in your Google Photos trash, which are left out otherwise
- when some photos came with two sets of details, choose **Let me choose for these**: those photos wait while everything else is imported, then you see each photo with both sets of details and pick the right ones for any you know; the rest get the most likely

Each file is copied into your library; the files in your export are never changed. A photo that is already in your library (the same file, by checksum) is not copied again: it joins its albums, keeps its own date and details, and only gains what it is missing when you fill in missing details. Running an import again, or retrying one, never creates a second copy of anything.

Photos from Google's Locked Folder go into Locked, and are locked before anything else is written to them. While your session is locked, the import only says how many photos go into Locked.

Every step that fails is retried once automatically. When the import finishes, it lists anything that could not be added, with **Try again**, and **Download report** saves a CSV of every photo and what happened to it.

**Cancel import** removes the import and what was uploaded for it. Everything it already brought into your library stays there.
