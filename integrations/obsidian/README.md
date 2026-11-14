# Frameleaf Images

Search the albums you choose to share from your Frameleaf Library and insert photos into a note. Each photo is saved in your vault as an ordinary image attachment, so the note keeps working offline and after you disconnect.

Desktop only (Windows, macOS and Linux). Requires Obsidian 1.11.4 or later and a Frameleaf Library with Connect.

## Connect

1. Open **Settings → Frameleaf Images** and enter your Library's HTTPS address, for example `https://photos.example.com`.
2. Select **Connect**. Your browser opens Frameleaf; sign in and choose the albums Obsidian may read. Sign-in must finish within 5 minutes.
3. Back in Obsidian, the settings show the Library and account you are connected to.

If your Library does not allow apps to register themselves, ask its administrator to register a public app with the return address `http://127.0.0.1/callback` and enter the App ID they give you. Obsidian listens on a random port on 127.0.0.1 only while you sign in.

Direct access to your Library over your own HTTPS address needs no Frameleaf Cloud plan. Reaching it through the Frameleaf relay follows your Cloud plan.

## Insert a photo

Run **Insert image from Frameleaf** from the command palette, search or pick an album, and select a photo. The plugin saves the preview rendition (JPEG, PNG or WebP, up to 16 MB) in your attachment folder as `frameleaf-<photo>-<revision>-preview.<ext>` and inserts a link using your link settings. Inserting the same photo again reuses the saved file; an edited photo gets a new revision. Turn on **Add a link to the photo in Frameleaf** to add a source link under the image.

The plugin only reads. It never uploads, edits or deletes anything in Frameleaf, does not sync in the background, and does not run on mobile.

## What is stored

- In `data.json` (which vault sync may copy): the Library address, App ID, Library and account identifiers and display names, and your settings. No tokens.
- In Obsidian's secret storage on this device: the refresh token, under an ID specific to this vault, Library and account. Obsidian decides how secret storage is kept; the plugin makes no claim about operating-system encryption.
- Access tokens stay in memory only.

**Disconnect** revokes the plugin's access in Frameleaf and removes the stored token. If the Library cannot be reached, the token is still removed from this device; also remove Frameleaf for Obsidian from your connected apps in Frameleaf. Images already saved in the vault stay there.

## Development

The source in this directory is the release: `main.js` is plain CommonJS with no build step and no dependencies beyond Obsidian and Node's built-in modules.

```sh
node --test integrations/obsidian/test/*.test.mjs
node integrations/obsidian/scripts/release.mjs /tmp/frameleaf-images
```

The release script checks the manifest and writes `mirror/` (the files a plugin repository needs at its root) and `release/<version>/` (`main.js`, `manifest.json`, `styles.css` and `SHA256SUMS`). Publishing a mirror repository, creating its GitHub release and submitting it to the community catalogue are separate release steps. See [provenance](PROVENANCE.md).
