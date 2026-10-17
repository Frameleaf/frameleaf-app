---
sidebar_position: 1
---

# Mobile Backup

The Frameleaf apps for iPhone, iPad and Android back up the photos and videos on your device to your Frameleaf server automatically. Open **Backup** in the app to see what is on the server, what is still waiting and why, and to start a backup right away with **Back Up Now**.

To install the app and connect it to your server, see [iPhone and Android Apps](./mobile-app.mdx).

## Choose what to back up

Open **Backup choices** in the app.

On iPhone and iPad, start from **Everything**, **Photos on Wi-Fi** or **Chosen albums**, then fine-tune:

- **Photos** and **Videos**: back up either or both.
- **Edited versions, stacked with the original**: a photo you edited in Photos is backed up as both the original and the edit, grouped together on the server. On by default.
- **Only from a date**: leave older photos on the phone.

On Android, choose **Everything on this phone**, **Camera photos and videos only**, or **Folders I choose**, and pick any folders to skip. You can also choose photos and videos, photos only or videos only, and whether to back up everything however old, only from today on, or since a date you pick.

## Choose when backup runs

On iPhone and iPad:

| Choice                     | Default | What it does                                                  |
| -------------------------- | ------- | ------------------------------------------------------------- |
| Photos on mobile data      | On      | Photos back up on mobile data as well as Wi-Fi.               |
| Videos on mobile data      | Off     | Videos wait for Wi-Fi.                                        |
| Videos only while charging | Off     | Videos wait until the device is charging.                     |
| Pause in Low Power Mode    | On      | Backup waits while Low Power Mode is on.                      |
| Pause in Low Data Mode     | On      | Backup waits while the network you're on is in Low Data Mode. |

On Android:

| Choice                | Default | What it does                              |
| --------------------- | ------- | ----------------------------------------- |
| Only on Wi-Fi         | Off     | Nothing backs up on mobile data.          |
| Videos wait for Wi-Fi | On      | Photos may use mobile data; videos wait.  |
| Only while charging   | Off     | Backup waits until the phone is charging. |

When something is waiting because of one of these choices, Backup says so, for example **Waiting for Wi-Fi** or **Waiting to charge**.

## Every photo is checked

Before uploading, the app fingerprints each original and asks your server whether it already has it, however it got there: from this phone, another device, the web app or an import. Anything already there is skipped, so nothing is uploaded twice.

A photo only counts as backed up once the server's copy matches the one on your phone. An upload that stops part way, because the connection dropped or the phone restarted, carries on where it stopped. Anything that didn't make it is listed under **Not on Server** with the reason, such as **Didn't arrive intact**, **Refused by your server** or **Not in your backup choices**, and you can retry it.

## Deleting on your phone never deletes on the server

Backup only ever adds to your server. Deleting a photo, video or album on your phone never deletes anything on the server, and never takes a photo out of a server album. (Taking a photo out of a synced album on the phone, without deleting it, takes it out of the matching server album only if the app put it there.) Signing out of a server or removing it from the app doesn't delete anything on the server either.

To make room on your phone once your photos are safely on the server, use [Free Up Space](./mobile-app.mdx#free-up-space).

## Albums

Your phone's albums (on iPhone and iPad) or folders (on Android) can become albums on your server. In the app's backup settings, under **Albums**, choose **Off**, all of them, or only the ones you pick. Photos already on the server are added to those albums too, and an existing server album with the same name is used instead of making a copy. See [Album sync](./mobile-app.mdx#album-sync).

## At home and away from home

At home, the app backs up straight to your server over your own network.

Away from home, the app can reach your server only when the server is linked to Frameleaf Cloud with a plan that includes remote access. Without one, Backup tells you the phone backs up when you're home, and it catches up the next time it's on your home network.

With remote access, the app connects straight to your server when it can, and through Frameleaf's relay when it can't. Photos and videos sent through the relay count toward your plan's relay allowance; connections at home don't. On Android, originals and videos wait for a direct connection unless you allow them over the relay in the app's settings. For how the direct connection works, see [Direct mobile backup](./direct-mobile-backup.md).

## Backing up in the background

### Android

- The app starts a backup about 30 seconds after you take a new photo or video, and catches up about every hour.
- The hourly catch-up waits while the battery is low.
- Some phones are strict about battery use and stop apps working in the background. If Backup says **Battery optimisation can pause backup**, allow Frameleaf to run in the background in your battery settings. [Don't kill my app](https://dontkillmyapp.com/) has guides for many phones.

### iPhone and iPad

- iOS decides when apps may work in the background. Frameleaf backs up overnight when iOS allows it, and keeps **Back Up Now** going for a while after you leave the app. On iOS 26.1 or later, iOS also uploads what is left in the background on its own.
- The more often you open the app, the more chances it gets. Open it, or tap **Back Up Now**, to back up right away.
- Keep **Background App Refresh** on for Frameleaf, in the Settings app under General > Background App Refresh.

<div style={{textAlign: 'center'}}>
<img src={require('./img/background-app-refresh.webp').default} width="30%" title="background-app-refresh" />
</div>

#### Photos stored only in iCloud

If you use **Optimize iPhone Storage** with iCloud Photos, some originals are only in iCloud. The app downloads each original from iCloud before backing it up, on Wi-Fi by default, and Backup shows how many iCloud originals are waiting. This uses some extra data and space on the device while it works.
