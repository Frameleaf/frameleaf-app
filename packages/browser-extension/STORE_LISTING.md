# Save to Frameleaf: Chrome Web Store listing (FL-669)

Draft text for the Chrome Web Store developer dashboard. The upload itself is done by hand from the Frameleaf developer account.

## Build the upload

```bash
pnpm --dir packages/browser-extension package
```

This builds the extension, checks it against the store's rules and writes `packages/browser-extension/release/save-to-frameleaf-<version>.zip`. The checks are: Manifest V3, a 128 px icon, every named file present, no `key` and no source maps, and a version matching `package.json`. Raise `version` in both `package.json` and `manifest.chromium.json` before each new upload; the store refuses a version it has already seen.

## Store listing

**Name:** Save to Frameleaf

**Summary** (132 characters at most):
Save images, pages and screenshots to your own Frameleaf library, into the collection you choose.

**Category:** Productivity (Tools is the alternative)

**Language:** English

**Description** (plain text; paste as is):

```text
Save to Frameleaf: your inspiration, in your own library

See something worth keeping? Save it to Frameleaf in two clicks. Images, pages and screenshots go straight into Boards, the free designer workspace in your own Frameleaf library. Not someone else's cloud.

Built for designers, makers and anyone who collects references: mood boards, brand refreshes, renovation ideas, product research.

WHAT YOU CAN SAVE
• Images from any page. Previews load by themselves as you scroll the list. Pick the ones you want, or select all, and filter by size and format.
• Whole pages as links, with their title, so your board shows more than a bare address.
• Screenshots: what you can see, an area you select, or the whole page in one picture (a very tall page is cut short, and you're told where).
• Right-click any image or page and save it to Frameleaf.
• Video, audio and galleries: ask your Frameleaf server to download a page's media, choose from what a page plays, or follow a creator so new posts keep arriving. Your server does the downloading, so it carries on with the browser closed.

ORGANISED AS YOU SAVE
• Choose a collection, or make a new one, without leaving the page.
• Add tags and a note while it's fresh in your mind.
• Your last collection is remembered, so the next save is one click.
• Each item keeps where it came from, so you can always find the original.

IT JUST KEEPS GOING
Saving carries on in the background after you close the tab. If you close the browser, or your server is offline, what's left waits and finishes once they're back. Nothing is lost.

SIGN IN, NO SETUP
Choose your Frameleaf server, sign in with your Frameleaf account and allow access once. There's no key to copy or paste. You can sign out, or remove the extension's access from Frameleaf, at any time.

PRIVATE BY DESIGN
• What you save goes only to your own Frameleaf server, at home or on Frameleaf Cloud.
• No analytics, no ads, no third-party services.
• The extension only reads a page when you choose to save from it.
• A site's sign-in is shared with your server only when you press Connect for that site, and only for that site. The extension keeps no copy.

WHAT YOU NEED
A Frameleaf server of your own, running at home or with Frameleaf Cloud. Boards is free with every Frameleaf library.

Learn more at https://frameleaf.app
```

**Website:** https://frameleaf.app
**Support:** https://frameleaf.app/help
**Privacy policy:** https://frameleaf.app/legal (check that the page covers the extension before submitting)

## Privacy practices tab

**Single purpose:**
Save images, pages, screenshots and media from the browser into the user's own Frameleaf library.

**Permission reasons** (one per permission, as the dashboard asks):

| Permission                                | Why the extension needs it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                                 | Remembers your server, your sign-in and the items waiting to save, so saving carries on after the browser restarts.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `activeTab`                               | Reads the page you are on only when you open Save to Frameleaf on it, to list its images or take a screenshot.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `scripting`                               | Runs a small script in the page you chose to save from, to find its images or scroll it for a whole-page screenshot. Nothing runs on pages you don't save from.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `alarms`                                  | Retries saving items that are waiting when your server was offline.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `contextMenus`                            | Adds "Save image to Frameleaf" (on images) and "Save page bookmark to Frameleaf" (on pages) to the right-click menu. They only start a save when you pick one.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `identity`                                | Opens Chrome's sign-in window, so you sign in to your Frameleaf server instead of pasting a key.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Optional host access (`https://*/*`, `http://*/*`) | Nothing is granted when the extension is added. It asks for your Frameleaf server's address when you connect it, and for a site's address the first time you save images from that site, so it can show previews of a page's images, download the ones you save from the site that hosts them (over `https` or plain `http`), and send what you save to your Frameleaf server, which lives at an address each person chooses. Previews and downloads go without cookies or a referrer, and nothing is saved until you choose Save. Connecting to your Frameleaf server over plain `http` is only allowed for a server on your own computer, when you turn that on. When you use media downloads, it also asks for the address of the one site you are on: to share that site's sign-in with your Frameleaf server when you press Connect, or to list the media that page requests when you press Watch this tab (and, only if you allow it, the other sites that page loads media from). |
| `cookies` (optional)                      | Not granted when the extension is added. Asked for when you press Connect for a site, together with that site's address. It reads the cookies the browser would send to that one site, shows you the domains, and sends them once, over HTTPS, to your own Frameleaf server so the server can download media you can only see when signed in. They are never stored in the extension, and no other site's cookies are read. |
| `webRequest` (optional)                   | Not granted when the extension is added. Asked for when you press Watch this tab on the Page tab. It lists the addresses of video and audio the tab you chose requests (playlists and files; stream fragments are grouped, never listed as videos), so you can choose which to send to your Frameleaf server. Requests are only observed, never changed; no headers or cookies are read; the list is kept in memory and cleared when the tab goes to another page. |

**Remote code:** No. All code is in the package; nothing is downloaded and run.

**Data use** (tick the categories that apply):

- **Website content:** yes. The images, page addresses and titles you choose to save, and the addresses of media you choose to download, are sent to your own Frameleaf server.
- **Authentication information:** yes. The access the extension gets when you sign in is stored in the browser and sent only to your server. When you press Connect for a site, that site's cookies are sent once to your own Frameleaf server and are not stored by the extension.
- **Web history:** no. Watching a tab for media lists only media addresses for the tab you chose, in memory, until that tab navigates.
- All other categories: no.

Certify that the data is:

- not sold to third parties;
- not used or transferred for purposes unrelated to saving to the user's library;
- not used to decide creditworthiness or for lending.

The extension sends data only to the Frameleaf server the user connects. There are no analytics, ads or third-party services.

## Images to prepare

| Asset                   | Size       | What to show                                                       |
| ----------------------- | ---------- | ------------------------------------------------------------------ |
| Store icon              | 128 × 128  | `icons/icon128.png`: the mark at 96 × 96, 16 px clear on each side |
| Screenshot 1 (required) | 1280 × 800 | Choosing images to save on a page, with the collection picker      |
| Screenshot 2            | 1280 × 800 | Signing in: Connect, then Allow Save to Frameleaf                  |
| Screenshot 3            | 1280 × 800 | Whole-page screenshot preview                                      |
| Screenshot 4            | 1280 × 800 | The save list, with items saving and saved                         |
| Screenshot 5            | 1280 × 800 | What you saved, in Boards in the web app                           |
| Small promo tile        | 440 × 280  | The Frameleaf mark with "Save to Frameleaf"                        |
| Marquee promo tile      | 1400 × 560 | The name and tagline beside the image picker, no transparency      |

Capture the screenshots from the real extension against a test server, not the prototype, and with no personal photos in view.

## Before the first upload

- Walk through the extension in a normal Chrome window: connect, sign in, save images, save a page, take each kind of screenshot, and use Open in the save list.
- Walk through media too, from the Page tab: allow media downloads, follow a channel or account, download one video or post (with and without following its creator too), download media from any other site with and without watching the tab, and connect, refresh and disconnect a site. Check each browser permission prompt names only the site you are on.
- Make sure `frameleaf.app/legal` covers the extension's data use as described above.
- After the first upload, the store assigns the extension's permanent id. The server's sign-in accepts any `https://<id>.chromiumapp.org/` return address, so no server change is needed.
