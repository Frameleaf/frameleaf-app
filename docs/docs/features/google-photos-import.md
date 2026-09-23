# Import Google Photos

**Import Google Photos** brings a Google Takeout export into your library: the original files, the dates they were taken, descriptions, locations, favorites, archived photos, Locked Folder photos and album memberships. Open it from **Settings → Google Photos & server imports → Preview import workflow**, from the administrator's **Import & protection** settings, or by searching for it.

The wizard has three stages: **Stage**, **Scan** and **Reconcile**.

## Stage

Choose every ZIP file from one Takeout export. Each archive is uploaded in parts; if the upload stops (the browser closed, the network dropped), choose the same files again and it carries on where it stopped. Every part already on the server is compared with the file you chose before anything is added, so a different file with the same name is refused rather than mixed in.

An archive is refused when your storage quota or the server's free space could not hold it.

Administrators can import from a folder on the server instead of uploading, but only from a folder inside one of the locations the server operator permitted with `IMMICH_IMPORT_ROOTS`. Folders are read without following links, and never from the library's own storage.

## Scan

The server reads each archive, stages its files under generated names and matches every photo and video with its metadata sidecar, including localized folder names, Google's shortened sidecar names and sidecars that ended up in a different archive of the same export. The scan runs on the server: you can close the page. It shows in **Activity** and the running-jobs panel, with a total that grows as the archives are read, and can be paused, resumed or stopped there or in the wizard.

Entries that could escape a folder (an unsafe name or a link), encrypted entries and damaged data are refused and counted, never staged.

## Reconcile

- **Review** lists every photo and video. Where several sidecars disagree, choose one or import without one; any item can be skipped or brought back.
- **Live Photos** lists photos and videos that share a name in the same folder. Link only the ones that belong together; both files are kept either way.
- **Albums** chooses which export folders become albums. Google's automatic year folders are off by default.
- **Import options** chooses what to bring over. **Recreate album memberships** adds photos already in your library to their albums too. **Review ambiguous sidecars** holds disputed items until you decide; switched off, they import with only the file's own details.
- **Report** summarizes what was imported, matched, skipped, unresolved and failed, and downloads the full reconciliation report as JSON or CSV.

**Import** runs on the server like the scan. Each file is copied into your library and checked against what the scan recorded; the files in your export are never changed. A photo that is already in your library (the same file, by checksum) is matched instead of copied again, keeps its own date and details, and only gains what it is missing when you turn on **Fill in missing details on photos already in your library**. Running an import again, or retrying one, never creates a second copy of anything.

Photos from Google's Locked Folder go into Locked, and are locked before anything else is written to them. While your session is locked, the wizard only says how many items go into Locked; unlock it to review them.

Every step that fails is retried once automatically, and items that failed are given one more attempt before they are reported. You can retry again from the wizard or from Activity.

**Delete import** removes the import and its staged copies once nothing is running. Everything it brought into your library stays there.
