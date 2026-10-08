# System Settings

The admin user can manage settings for the Frameleaf instance here.

## Saving changes

Every settings page edits one draft. Changes you make on one page are kept while you visit another, and pages with unsaved changes are marked in the settings list.

- **Review changes** lists every change with its page, the saved value and the new value. **Save changes** saves them all at once. Server credentials are never part of the draft; they are replaced or cleared on their own (see below).
- **Discard** returns every page to the saved settings. **Reset this page** puts that page's defaults into the draft; they are applied when you save.
- If another administrator saves settings while you are editing, your draft is kept. Changes to different settings are carried onto theirs and you save again. When you both changed the same setting, the page lists each one with the saved value and yours: keep your changes on the latest settings, or discard your draft and load the latest.
- Leaving the settings page with unsaved changes asks you to keep editing or discard them. Reloading the tab brings the draft back, except passwords, keys and addresses that contain credentials, which are never stored in the browser.
- **Export as JSON** and **Copy to clipboard** leave out passwords, secrets and keys. **Import from JSON** puts the file's settings into the draft for you to review; settings this server does not have are listed and ignored, and credentials in the file are never applied.
- **Change history** lists every change saved from these settings pages (including credential changes), newest first, with the administrator who saved it, the time, and each setting before and after. It is kept on the server, so every administrator sees the same history (the latest 50 saves). Credentials appear only as replaced or cleared, and credentials inside addresses are removed.
- Actions that start or change something on the server, such as sending a test email or unlinking OAuth accounts, run on their own. Sending a test email also saves the email settings, and nothing else.

## Server credentials

The OAuth client secret and the SMTP password are **write-only**. Their settings show whether a value is stored (**Stored** or **Not set**), never the value itself:

- **Replace credential** opens a dialog with a single field. The value is sent once, checked like any settings change (for example, the mail server is verified with a new SMTP password), and cleared from the dialog when it closes.
- **Clear** removes the stored value after a confirmation.
- Saving any other setting, **Copy to clipboard**, **Export as JSON** and **Import from JSON** never carry a credential. A configuration file that contains credentials is imported without them, and the page says so.
- **Send test email** uses the stored SMTP password as long as the server, port, username and security settings on the page match the saved ones.
- A stored secret never follows a server change: saving a different mail server host or username clears the SMTP password, and saving a different OAuth issuer URL clears the client secret. Replace the credential for the new server. If sending email is on and the new server needs a password, turn email off, save the new server, replace the password, then turn email on again.
- Every replacement or removal is written to the server log by credential name and administrator, never by value.

Scripts can use `GET /api/admin/config/credentials` to see which credentials are stored, and `PUT` or `DELETE /api/admin/config/credentials/{name}` to replace or clear one. For compatibility, a full configuration sent with a non-empty credential still sets it; an empty value keeps the stored one. While a configuration file manages the settings, credentials come from that file and cannot be changed here.

## Authentication Settings

Manage password, OAuth, and other authentication settings

### OAuth Authentication

Frameleaf supports OAuth Authentication. Read more about this feature and its configuration [here](/administration/oauth).

### Password Authentication

The administrator can choose to disable login with username and password for the entire instance. This means that **no one**, including the system administrator, will be able to log using this method. If [OAuth Authentication](/administration/oauth) is also disabled, no users will be able to login using **any** method. Changing this setting does not affect existing sessions, just new login attempts.

:::tip
You can always use the [Server CLI](/administration/server-commands) to re-enable password login.
:::

## Image Settings (thumbnails and previews)

- Thumbnails - Used in the main timeline.
- Previews - Used in the asset viewer.

By default Frameleaf creates 3 thumbnails for each asset,
Blurred (thumbhash) , Small - thumbnails (webp) , and Large - previews (jpeg/webp), using these settings you can change the quality for the thumbnails and previews files that are created.

**Thumbnail format**  
Allows you to choose the type of format you want for the Thumbnail images, Webp produces smaller files than jpeg, but is slower to encode.

:::tip
You can read in detail about the advantages and disadvantages of using webp over jpeg on [Adobe's website](https://www.adobe.com/creativecloud/file-types/image/raster/webp-file.html)
:::

**Thumbnail resolution**  
Used when viewing groups of photos (main timeline, album view, etc.). Higher resolutions can preserve more detail but take longer to encode, have larger file sizes, and can reduce app responsiveness.

**Preview format**  
Allows you to choose the type of format you want for the Preview images, Webp produces smaller files than jpeg, but is slower to encode.

**Preview resolution**  
Used when viewing a single photo and for machine learning. Higher resolutions can preserve more detail but take longer to encode, have larger file sizes, and can reduce app responsiveness.

**Video thumbnail selection**
For video assets, Frameleaf samples multiple candidate frames before writing the preview, thumbnail, and thumbhash. For longer videos, candidates prefer frames at least 30 seconds into the video. For short videos, Frameleaf uses proportional timestamps and chooses the best frame based on brightness, contrast, and detail while rejecting black, blown-out, or flat frames.

**Quality**  
Image quality from 1-100. Higher is better for quality but produces larger files, this option affects the Preview and Thumbnail images.

**Prefer wide gamut**  
Use Display P3 for thumbnails. This better preserves the vibrance of images with wide colorspaces, but images may appear differently on old devices with an old browser version. sRGB images are kept as sRGB to avoid color shifts.

**Prefer embedded preview**  
Use embedded previews in RAW photos as the input to image processing when available. This can produce more accurate colors for some images, but the quality of the preview is camera-dependent and the image may have more compression artifacts.

:::tip
The default resolution for Large thumbnails can be lowered from 1440p (default) to 1080p or 720p to save storage space.
:::

## Job Settings

Using these settings, you can determine the amount of work that will run concurrently for each task in microservices. Some tasks can be set to higher values on computers with powerful hardware and storage with good I/O capabilities.

With higher concurrency, the host will work on more assets in parallel,
this advice improves throughput, not latency, for example, it will make Smart Search jobs process more quickly, but it won't make searching faster.

It is important to remember that jobs like Smart Search, Face Detection, Facial Recognition, and Transcode Videos require a **lot** of processing power and therefore do not exaggerate the amount of jobs because you're probably thoroughly overloading the server.

:::danger IMPORTANT
If you increase the concurrency from the defaults we set, especially for thumbnail generation, make sure you do not increase them past the amount of CPU cores you have available.
Doing so can impact API responsiveness with no gain in thumbnail generation speed.
:::

:::info Facial Recognition Concurrency
The Facial Recognition Concurrency value cannot be changed because
[DBSCAN](https://www.youtube.com/watch?v=RDZUdRSDOok) is traditionally sequential, but there are parallel implementations of it out there. Our implementation isn't parallel.
:::

## External Library

### Library watching (EXPERIMENTAL)

External libraries can automatically import changed files without a full rescan. It will import the file whenever the operating system reports a file change. If your photos are mounted over the network, this does not work.

### Periodic Scanning

You can define a custom interval for the trigger external library rescan under Administration -> Settings -> Library.  
You can set the scanning interval using the preset or cron format. For more information please refer to e.g. [Crontab Guru](https://crontab.guru/).

## Logging

The default Frameleaf log level is `Log` (commonly known as `Info`). The Frameleaf administrator can choose a higher or lower log level according to personal preference or as requested by support.

## Machine Learning Settings

Through this setting, you can manage all the settings related to machine learning in Frameleaf, from the setting of remote machine learning to the model and its parameters
You can choose to disable a certain type of machine learning, for example smart search or facial recognition.

### URL

The release configures its local machine-learning service by default. You can add other endpoints and route work explicitly through [Workers and endpoints](./workers-and-endpoints.md).

Hosting the machine-learning container on a machine with a more powerful GPU can be helpful to for processing a large number of photos (such as during batch import) or for faster search.

If more than one URL is provided, each server will be attempted one-at-a-time until one responds successfully, in order from first to last. Servers that don't respond will be temporarily ignored until they come back online.

### Smart Search

The [smart search](/features/searching) settings allow you to change the [CLIP model](https://openai.com/research/clip). Larger models will typically provide more accurate search results but consume more processing power and RAM. When [changing the CLIP model](/FAQ#can-i-use-a-custom-clip-model) it is mandatory to re-run the Smart Search job on all images to fully apply the change.

:::info Internet connection
Changing models requires a connection to the Internet to download the model.
After downloading, there is no need for Frameleaf to connect to the network
Unless version checking has been enabled in the settings.
:::

### Image Descriptions and Tags

The [image enrichment](/features/image-enrichment) settings allow you to generate searchable descriptions and tags for image assets. Existing user descriptions are preserved, and generated descriptions are appended once. Generated tags are plain searchable tags and are deduplicated against existing tags.

This feature is independent from Smart Search. Smart Search uses CLIP embeddings for contextual search, while image enrichment writes visible descriptions and tags to asset metadata.

### NSFW Detection

The NSFW detection settings allow you to classify image assets with a dedicated safety model. The detection result is stored privately, and Frameleaf can add a visible `nsfw` tag plus specific reason tags when supported by the image content and classifier result.

The private NSFW flag is the source of truth for privacy features. Tags are searchable metadata and should not be treated as a security boundary. If `Hide detected NSFW assets` is enabled, flagged assets are hidden from non-elevated library, shared-link, download, and sync responses until the current session is unlocked with the locked-folder PIN. Album membership is preserved while hidden assets are filtered from non-elevated responses.

### Duplicate Detection

Use CLIP embeddings to find likely duplicates. The maximum detection distance can be configured in order to improve / reduce the level of accuracy.

- **Maximum detection distance -** Maximum distance between two images to consider them duplicates, ranging from 0.001-0.1. Higher values will detect more duplicates, but may result in false positives.

### Facial Recognition

Under these settings, you can change the facial recognition settings
Editable settings:

- **Facial Recognition Model**
- **Min Detection Score**
- **Max Recognition Distance**
- **Min Recognized Faces**

You can learn more about these options on the [Facial Recognition page](/features/facial-recognition#how-face-detection-works)

:::info
When changing the values in Min Detection Score, Max Recognition Distance, and Min Recognized Faces.
You will have to restart **only** the job FACIAL RECOGNITION - ALL.

If you replace the Facial Recognition Model, you will have to run the job FACE DETECTION - ALL.
:::

:::tip identical twins
If you have twins, you might want to lower the Max Recognition Distance value, decreasing this a **bit** can make it distinguish between them.
:::

## Map & GPS Settings

### Map Settings

In these settings, you can change the appearance of the map in night and day modes according to your personal preference and according to the supported options.
The map can be adjusted via [OpenMapTiles](https://openmaptiles.org/styles/) for example.

### Reverse Geocoding Settings

Frameleaf supports [Reverse Geocoding](/features/reverse-geocoding) using data from the [GeoNames](https://www.geonames.org/) geographical database.

## Notification Settings

SMTP server setup, for user creation notifications, new albums, etc. More information can be found [here](/administration/email-notification)

## Notification Templates

Override the default notifications text with notification templates. More information can be found [here](/administration/email-notification)

## Server Settings

### Public server URL

The address this server puts in shared links, emails, maintenance login links and sign-in callbacks is set in **Frameleaf Cloud → Remote access → Public server URL**. It is saved with your other settings changes, needs no cloud link, and should not include a trailing slash. Without a public URL, emails are sent without links (see [email notifications](./email-notification.mdx#links-in-emails)).

### Local network discovery

**Local network discovery** lets the Frameleaf apps find this server on the same Wi-Fi without typing an address. It is on by default. Turn it off here to stop advertising; direct connections and sign-in requirements don't change.

While it is on, the server advertises one DNS-SD (Bonjour/mDNS) service on the LAN:

| Field        | Value                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------- |
| Service type | `_frameleaf._tcp`                                                                              |
| Port         | the server's HTTP port (`FRAMELEAF_PORT`, 2283 by default)                                     |
| Service name | the server's display name, or `Frameleaf server` when none is set                              |
| TXT `id`     | the Frameleaf Cloud instance id while the server is linked, otherwise a stable local server id |
| TXT `name`   | the same display name                                                                          |
| TXT `setup`  | `needed` while the server has no administrator, otherwise `complete`                           |
| TXT `linked` | `true` while the server is linked to Frameleaf Cloud, otherwise `false`                        |
| TXT `cloud`  | `available` when `FRAMELEAF_CLOUD_URL` is set (the server can link), otherwise `unavailable`   |

`id` and `name` are the same identity that the unauthenticated `GET /api/server/ping` returns, so an app can confirm it reached the server it expects on every route. `setup`, `linked` and `cloud` are also in the ping response, so the Frameleaf app can offer to set up a new server it finds. Neither carries anything about users or content, nor the setup code. The record is published again when that state changes.

## Setting up a new server

A new server has no administrator. Until it has one, it shows a **setup code** (eight letters and digits, shown as `XXXX-XXXX`) on its console and in its log every time it starts, with a QR code of the same value for the Frameleaf app to scan. The code is the proof that you control the server. Whoever reaches the server first can't claim it without the code, from the app or from the web page.

- **Where to find it:**
  - With Docker Compose: `docker logs frameleaf_server`, or print it again with `docker exec -it frameleaf_server frameleaf-admin setup-code`.
  - On Unraid, TrueNAS or Synology: the container's log.
- **When it changes:** a new code is made every time the server starts. After five wrong tries a new code is shown and the old one stops working.
- **Pinning the code:** for automated installs and tests, set `FRAMELEAF_SETUP_CODE`. A pinned code is not replaced after wrong tries; it locks until the next start instead, so anyone on the network can lock it. Don't pin it on a server people use.
- **Where it works:** only from the home network, never over remote access. A request counts as home when it comes from a private address, or through a trusted local reverse proxy that passes the visitor's address in `X-Forwarded-For`. Tries are limited per address. The code stops working once an administrator exists. A server that is not on your home network (a rented server, for example) can be set up through an SSH tunnel to it, or by adding your network to `FRAMELEAF_TRUSTED_LAN_CIDRS`.
- **Keeping it private:** the code is only as private as the server's console and log. It is printed to the console whatever the log level. Once the server is set up it is worthless.
- **Onboarding:** whether the first-run onboarding is finished is reported by `GET /api/server/config` (`isOnboarded`), so the app can say so.

There are three ways to claim a new server, and each needs the code:

- **Web page:** the first-run page asks for the code together with the administrator's name, email and password.
- **Frameleaf app, with a Frameleaf account:** the app checks the code and gets a short-lived, single-use setup ticket. With the ticket it hands the server a single-use link token (`fll_…`) and the name you chose, and the server links itself exactly as with `FRAMELEAF_LINK_TOKEN`. The Frameleaf account that made the token owns the server. That account's first Sign in with Frameleaf creates the administrator, with no server password. Only that account can become the first administrator.
- **Frameleaf app, with a password:** the app can instead create the administrator with an email and password, for a server without Frameleaf Cloud.

`FRAMELEAF_LINK_TOKEN` itself needs no code, because whoever sets it already controls the host. Linking a server that is already set up is done by an administrator (in Settings, or from the app), and needs no code either. Once it is linked, that administrator's account is connected to the Frameleaf account that approved the link.

The server only advertises when it can see a LAN interface. Inside a container on a bridge network it usually can't, so nothing is advertised; use host networking if you want discovery from a container. Anyone on the network can see the display name, so choose one that doesn't reveal a person's name. A rename is advertised again straight away.

### Welcome Message

The administrator can set a custom message on the login screen (the message will be displayed to all users).

## Storage Template

Frameleaf supports a custom [Storage Template](/administration/storage-template). Learn more about this feature and its configuration [here](/administration/storage-template).

## Theme Settings

You can write custom CSS that will get loaded in the web application for all users. This enables administrators to change fonts, colors, and other styles.

For example:

```css title='Custom CSS'
p {
  color: green;
}
```

## Trash Settings

In the system administrator's option to set a trash for deleted files, these files will remain in the trash until the deletion date 30 days (default) or as defined by the system administrator.

The trash can be disabled, however this is not recommended as future files that are deleted will be permanently deleted.

:::tip Keyboard shortcut for permanently deletion
You can select assets and press Ctrl + Del from the timeline for quick permanent deletion without the trash option.
:::

## User Settings

### Delete delay

The system administrator can choose to delete users through the administration panel, the system administrator can delete users immediately or alternatively delay the deletion for users (7 days by default) this action permanently delete a user's account and assets. The user deletion job runs at midnight to check for users that are ready for deletion. Changes to this setting will be evaluated at the next execution.

## Version Check

When this option is enabled the server asks Frameleaf's release feed for a new version every hour, and administrators see an announcement that links to the release notes. If the feed cannot answer, the server asks Frameleaf's own GitHub releases (`https://api.github.com/repos/Frameleaf/frameleaf-app/releases`) instead and reads the version from the `frameleaf-v<version>-<n>` release tag. No upstream service is contacted, and no library data or instance identifier is sent to either. The **Update channel** choice picks Stable releases (`stable`) or also release candidates (`beta`). Turn this option off to stop the check.

Checking never installs anything. An administrator can also check at any time with **Check for updates** in About Frameleaf or on the Versions & compatibility page, even when automatic checks are off. Other accounts see the result of the last check in About Frameleaf.

## Video Transcoding Settings

The system administrator can configure which video files will be converted to different formats. The settings can be changed in depth, to learn more about the terminology used here, refer to FFmpeg documentation for [H.264](https://trac.ffmpeg.org/wiki/Encode/H.264) codec, [HEVC](https://trac.ffmpeg.org/wiki/Encode/H.265) codec and [VP9](https://trac.ffmpeg.org/wiki/Encode/VP9) codec.

Which streams of a video file will be transcoded is determined by the [Transcode Policy](#ffmpeg.transcode). Streams that are transcoded use the following settings (config file name in brackets). Streams that are not transcoded are untouched and preserve their original settings.

### Accepted containers (`ffmpeg.acceptedContainers`) {#ffmpeg.acceptedContainers}

If the video asset's container format is not in this list, it will be remuxed to MP4 even if no streams need to be transcoded.

The default set of accepted container formats is `mov`, `ogg` and `webm`.

### Preset (`ffmpeg.preset`) {#ffmpeg.preset}

The amount of "compute effort" to put into transcoding. These use [the preset names from h264](https://trac.ffmpeg.org/wiki/Encode/H.264#Preset) and will be converted to appropriate values for encoders that configure effort in different ways.

The default value is `ultrafast`.

### Audio codec (`ffmpeg.targetAudioCodec`) {#ffmpeg.targetAudioCodec}

Which audio codec to use when the audio stream is being transcoded. Can be one of `mp3`, `aac`, `opus`.

The default value is `aac`.

### Video Codec (`ffmpeg.targetVideoCodec`) {#ffmpeg.targetVideoCodec}

Which video codec to use when the video stream is being transcoded. Can be one of `h264`, `hevc`, `vp9` or `av1`.

The default value is `h264`.

### Target resolution (`ffmpeg.targetResolution`) {#ffmpeg.targetResolution}

When transcoding a video stream, downscale the largest dimension to this value while preserving aspect ratio. Videos are never upscaled.

The default value is `720`.

### Transcode policy (`ffmpeg.transcode`) {#ffmpeg.transcode}

The transcoding policy configures which streams of a video asset will be transcoded. The transcoding decision is made independently for video streams and audio streams. This means that if a video stream needs to be transcoded, but an audio stream does not, then the video stream will be transcoded while the audio stream will be copied. If the transcoding policy does not require any stream to be transcoded and does not require the video to be remuxed, then no separate video file will be created.

The default policy is `required`.

#### All videos (`all`) {#ffmpeg.transcode-all}

Videos are always transcoded. This ensures consistency during video playback.

#### Don't transcode any videos (`disabled`) {#ffmpeg.transcode-disabled}

Videos are never transcoded. This saves space and resources on the server, but may prevent playback on devices that don't support the source format (especially web browsers) or result in high bandwidth usage when playing high-bitrate files.

#### Only videos not in an accepted format (`required`) {#ffmpeg.transcode-required}

Video streams are transcoded when any of the following conditions are met:

- The video is HDR.
- The video is not in the yuv420p pixel format.
- The video codec is not in `acceptedVideoCodecs`.

Audio is transcoded if the audio codec is not in `acceptedAudioCodecs`.

#### Videos higher than max bitrate or not in an accepted format (`bitrate`) {#ffmpeg.transcode-bitrate}

In addition to the conditions in `required`, video streams are also transcoded if their bitrate is over `maxBitrate`.

#### Videos higher than target resolution or not in an accepted format (`optimal`) {#ffmpeg.transcode-optimal}

In addition to the conditions in `required`, video streams are also transcoded if the horizontal **and** vertical dimensions are higher than [`targetResolution`](#ffmpeg.targetResolution).
