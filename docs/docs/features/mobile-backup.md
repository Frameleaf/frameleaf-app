---
sidebar_position: 1
---

# Mobile Backup

## Overview

The Frameleaf iPhone and Android apps upload photos and videos from your phone to the server automatically. Open **Backup** in the app to choose what to back up and to start a backup.

## General Features

### Backup choices

Choose everything, only camera photos and videos, or albums and folders you pick. You can skip any album or folder, and choose photos, videos or both.

### Every photo is checked

Each original is fingerprinted with SHA-256 on the phone and compared with what your server already has, whether it arrived from this phone, another device, the web app, the CLI or an import. Anything already there is skipped, so nothing is uploaded twice. Uploads are resumable: an interrupted upload, a crash, a reboot or a change of network picks up where it stopped. A photo only counts as backed up when the server's fingerprint matches the phone's; anything that didn't make it is listed under **Not on Server**, with the reason and Retry.

Edited versions, such as edits from Apple Photos or files like `IMG_1-edited.jpg` from a gallery app, are uploaded and **stacked** with their original.

### Networking requirements

You decide when backup may run. Both apps can keep videos waiting for Wi-Fi while photos use mobile data, never use mobile data at all, or only run while the phone is charging.

Native foreground backup keeps direct HTTPS first and can use a resource-scoped
WebRTC data channel when its HTTPS route would otherwise use the relay. A failed
direct connection resumes the same upload over permitted HTTPS after reading its
durable offset. See [Direct mobile backup](./direct-mobile-backup.md) for the
protocol, relay policy and background limitations.

### Album sync

Phone albums can be mirrored to albums on the server. Sync is one-way and only adds: deleting a photo on the phone, or removing it from a phone album, never removes it from the server or from a server album.

## Platform Specific Features

### Android

- The app catches up every hour, and starts a backup about 30 seconds after you take a photo.
- Backup always waits while the battery is low.
- Some Android models are very strict with battery optimization and stop background work. If backup tells you battery optimization is in the way, allow the app to run in the background. [Don't kill my app](https://dontkillmyapp.com/) has a guide for many phones.

### iOS

- iOS decides when apps may work in the background, so the app makes the most of every chance it gets. It runs an overnight backup when iOS allows it, keeps **Back Up Now** going after you leave the app and, on iOS 26.1 or later, hands remaining photos and videos to iOS's own background upload. The more often you open the app, the more chances it gets.
- Backup pauses in Low Power Mode and Low Data Mode by default.
- Keep **Background App Refresh** on for the app, in the Settings app under General > Background App Refresh.

<div style={{textAlign: 'center'}}>
<img src={require('./img/background-app-refresh.webp').default} width="30%" title="background-app-refresh" />
</div>

#### Photos stored in iCloud

If you use **Optimize iPhone Storage** in iCloud, the app downloads the full originals from iCloud on Wi-Fi and backs them up, and Backup shows how many iCloud originals are waiting. This uses some extra data and space on the phone while it works.
