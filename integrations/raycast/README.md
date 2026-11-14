# Frameleaf for Raycast

Search, browse, open, copy and download photos from your Frameleaf Library without leaving Raycast. The extension reads only the albums you choose when you connect.

## Commands

- **Search Photos** searches file names and captions. Filter by photos or videos from the search bar.
- **Browse Albums** lists the albums you authorized. Press Return to see an album’s photos.
- **Disconnect Library** revokes the extension’s access at your Library and forgets its sign-in.

Select a photo to see a preview. Previews are fetched only for the selected photo and are deleted when the command closes.

| Action            | macOS  | Windows      |
| ----------------- | ------ | ------------ |
| Open in Frameleaf | Return | Enter        |
| Copy image        | ⌘ ⇧ C  | Ctrl Shift C |
| Copy link         | ⌘ ⇧ L  | Ctrl Shift L |
| Download          | ⌘ D    | Ctrl D       |
| Download original | ⌘ ⇧ D  | Ctrl Shift D |
| Reload            | ⌘ R    | Ctrl R       |

Downloads go to your Downloads folder and never replace an existing file. A normal download is a large JPEG without location or camera details. **Download Original** appears only after you turn on **Original downloads** in the extension preferences and allow it when you connect; it saves the file exactly as stored, including its location and camera details. If you turn it on after connecting, choose **Allow Original Downloads** on any photo to ask again. Videos download as a still image; open them in Frameleaf to play or save the video.

## Connect

1. Open any command and enter your Library address, for example `https://photos.example.com`.
2. Sign in to your Library in the browser and choose the albums Raycast can read, or allow your whole library.
3. Return to Raycast.

You can change the albums later under **Connected apps** in your Library’s settings. Raycast sees the change on its next request.

Use HTTPS when you can: your own domain, a certificate on your network, or Frameleaf relay. Plain HTTP is accepted only for addresses on your own network (such as `http://192.168.1.20:2283` or `http://nas.local:2283`); sign-in and photos then travel unencrypted on that network. A direct connection doesn’t need a Frameleaf Cloud plan; relay follows your Cloud plan.

If your Library doesn’t let apps register themselves, ask its administrator to register an app with the return address `https://raycast.com/redirect?packageName=Extension`, then enter its Client ID in the extension preferences.

## Privacy

The extension asks for `library:read`, and for `library:download` only when you turn on original downloads. It can’t see people, locations, sharing, or albums you didn’t choose, and it can’t change or delete anything. Sign-in tokens are kept in Raycast’s encrypted storage and are sent only to your Library. Disconnecting revokes them; it doesn’t remove photos you already downloaded or copied.

## Troubleshooting

- **Library unavailable**: Raycast couldn’t reach the address. Results you already loaded stay visible; choose **Try Again** when you’re back online.
- **Not connected**: access was revoked, or sign-in didn’t finish. Choose **Connect Again**.
- **This address now belongs to a different Library**: check the address. Choose **Connect Again** only if you trust that Library.
- **Disconnect couldn’t reach your Library**: Raycast keeps its sign-in so it can try again. You can also remove Raycast under **Connected apps** in your Library’s settings.

## Help in other languages

The Raycast interface is English only. This guide is available in [Dansk](help/da.md), [Deutsch](help/de.md), [English](help/en.md), [Español](help/es.md), [Français](help/fr.md), [Italiano](help/it.md), [Norsk bokmål](help/nb_NO.md), [Nederlands](help/nl.md), [Polski](help/pl.md), [Português](help/pt.md) and [Svenska](help/sv.md).

## Development

Requires Node.js 22.22 or later.

```sh
npm ci
npm test
npm run build
npm run dev
```

`npm test` exercises the Connect protocol client with synthetic servers. It doesn’t prove a live OAuth round trip through Raycast’s redirect; qualify that against a real Library before publishing.
