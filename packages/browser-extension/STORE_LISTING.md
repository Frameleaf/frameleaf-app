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

**Description:**

> Save to Frameleaf puts what you find on the web straight into Boards, the free designer workspace in your own Frameleaf library.
>
> • Save images from any page: choose which ones, then pick a collection, tags and a note.
> • Save a page as a link with its title, never a copy of the page.
> • Take a screenshot of what you can see, an area you select, or the whole page.
> • Right-click any image or page and choose "Save to Frameleaf".
> • Saving carries on in the background, even after you close the window, and waits if your server is offline.
>
> Sign in with your Frameleaf account: choose your server, sign in and allow access once. There is no key to copy. The extension can only save things and list your collections and tags, and you can sign out or remove its access at any time.
>
> You need a Frameleaf server of your own, at home or with Frameleaf Cloud. Nothing you save goes anywhere else.

**Website:** https://frameleaf.app
**Support:** https://frameleaf.app/help
**Privacy policy:** https://frameleaf.app/legal (check that the page covers the extension before submitting)

## Privacy practices tab

**Single purpose:**
Save images, pages and screenshots from the browser into the user's own Frameleaf library.

**Permission reasons** (one per permission, as the dashboard asks):

| Permission                                         | Why the extension needs it                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                                          | Remembers your server, your sign-in and the items waiting to save, so saving carries on after the browser restarts.                                                                                                                                                                                                    |
| `activeTab`                                        | Reads the page you are on only when you choose Save, to list its images or take a screenshot.                                                                                                                                                                                                                          |
| `scripting`                                        | Runs a small script in the page you chose to save from, to find its images or scroll it for a whole-page screenshot. Nothing runs on pages you don't save from.                                                                                                                                                        |
| `alarms`                                           | Retries saving items that are waiting when your server was offline.                                                                                                                                                                                                                                                    |
| `contextMenus`                                     | Adds "Save image to Frameleaf" and "Save page to Frameleaf" to the right-click menu.                                                                                                                                                                                                                                   |
| `identity`                                         | Opens Chrome's sign-in window, so you sign in to your Frameleaf server instead of pasting a key.                                                                                                                                                                                                                       |
| Optional host access (`https://*/*`, `http://*/*`) | Asked for only for the Frameleaf server address you enter, when you connect, so the extension can send what you save to it. Frameleaf servers live at addresses each person chooses, so the address can't be listed in advance. Plain `http` is only allowed for a server on your own computer, when you turn that on. |

**Remote code:** No. All code is in the package; nothing is downloaded and run.

**Data use** (tick the categories that apply):

- **Website content:** yes. The images, page addresses and titles you choose to save are sent to your own Frameleaf server.
- **Authentication information:** yes. The access the extension gets when you sign in is stored in the browser and sent only to your server.
- All other categories: no.

Certify that the data is:

- not sold to third parties;
- not used or transferred for purposes unrelated to saving to the user's library;
- not used to decide creditworthiness or for lending.

The extension sends data only to the Frameleaf server the user connects. There are no analytics, ads or third-party services.

## Images to prepare

| Asset                   | Size       | What to show                                                  |
| ----------------------- | ---------- | ------------------------------------------------------------- |
| Store icon              | 128 × 128  | Shipped as `icons/icon128.png` (the Frameleaf mark)           |
| Screenshot 1 (required) | 1280 × 800 | Choosing images to save on a page, with the collection picker |
| Screenshot 2            | 1280 × 800 | Signing in: Connect, then Allow Save to Frameleaf             |
| Screenshot 3            | 1280 × 800 | Whole-page screenshot preview                                 |
| Screenshot 4            | 1280 × 800 | The save list, with items saving and saved                    |
| Screenshot 5            | 1280 × 800 | What you saved, in Boards in the web app                      |
| Small promo tile        | 440 × 280  | The Frameleaf mark with "Save to Frameleaf"                   |
| Marquee (optional)      | 1400 × 560 | Only if the store features the extension                      |

Capture the screenshots from the real extension against a test server, not the prototype, and with no personal photos in view.

## Before the first upload

- Walk through the extension in a normal Chrome window: connect, sign in, save images, save a page, take each kind of screenshot, and use Open in the save list.
- Make sure `frameleaf.app/legal` covers the extension's data use as described above.
- After the first upload, the store assigns the extension's permanent id. The server's sign-in accepts any `https://<id>.chromiumapp.org/` return address, so no server change is needed.
