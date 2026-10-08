# OPS-07 · Video transcoding and hardware transcoding

| Field | Value |
| --- | --- |
| Series | Running Frameleaf |
| Type | How-to |
| Target length | 2:45 |
| Audience | Administrators whose videos do not play everywhere, or whose server struggles to convert them |
| Features demonstrated | Editing & playback → Video playback proxies, Transcode policy (all five options), Accepted video codecs, Accepted audio codecs, Accepted containers, Encoding Options (Video codec, Audio codec, Target resolution, Constant rate factor, Preset), hardware transcoding APIs, hwaccel.transcoding.yml and the extends section, Acceleration API, Hardware decoding, Constant quality mode, verifying with the GPU check, limits |
| Source docs | docs/docs/features/hardware-transcoding.md, docs/docs/administration/system-settings.md |
| Capture checklist | Taylor signed in as administrator on frameleaf.home, dark theme, on a Linux host with an Intel CPU that has Quick Sync and `/dev/dri`. Kayaking.mov (0:18) in the library. Settings → Editing & playback → Video playback proxies at the defaults (Only videos not in an accepted format, H.264, AAC, 720p, crf 23, ultrafast, Acceleration API Disabled, Hardware decoding on). The Frameleaf release folder with `docker-compose.yml` and `hwaccel.transcoding.yml`. Settings → Compute & jobs → Hardware & GPU for the check. Blur GPU names. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:13 | LOWER-THIRD "Video transcoding and hardware transcoding · Running Frameleaf". SCREEN: the viewer playing Kayaking.mov in a browser; a small CARD in the corner: "Original · kept" and "Playback copy · made when needed". | Original kept · playback copy when needed | "Not every browser or phone plays every video. Frameleaf keeps your original and, when needed, makes a playback copy that plays everywhere." |
| 3 | 0:13–0:22 | SCREEN: Settings → Editing & playback; CURSOR clicks "Video playback proxies" ("Copies that play smoothly on every device."). HIGHLIGHT the group "Transcode Policy". | Settings → Editing & playback → Video playback proxies | "Open Settings, then Editing & playback, then Video playback proxies. Transcode policy decides which videos get a copy." |
| 4 | 0:22–0:41 | CURSOR opens the "Transcode policy" dropdown: "All videos", "Videos higher than target resolution or not in an accepted format", "Videos higher than max bitrate or not in an accepted format", "Only videos not in an accepted format" (selected), "Don't transcode any videos, may break playback on some clients". HIGHLIGHT each as the VO names it. | Transcode policy | "The default, Only videos not in an accepted format, converts HDR video, unusual pixel formats and codecs you have not accepted. Other choices also convert videos above the target resolution or bitrate, convert everything, or nothing at all, which can break playback on some devices." |
| 5 | 0:41–0:56 | ZOOM on the checkboxes: "Accepted video codecs" (H.264 ticked; HEVC, VP9, AV1 clear), "Accepted audio codecs" (AAC, MP3, Opus ticked), "Accepted containers" (MOV, Ogg, WebM ticked). CALLOUT "Other containers → MP4". | Accepted video codecs · Accepted audio codecs · Accepted containers | "Accepted video codecs, audio codecs and containers set what counts as accepted. Out of the box that is H.264 video with AAC, MP3 or Opus audio, in MOV, Ogg or WebM. Other containers are repackaged as MP4." |
| 6 | 0:56–1:10 | SCREEN scrolls to "Encoding Options": Video codec h264, Audio codec aac, Target resolution 720p, Constant rate factor (-crf) 23, Preset (-preset) ultrafast, Maximum bitrate 0. HIGHLIGHT each as named. CALLOUT on Target resolution "Never upscaled". | Encoding Options | "Encoding Options shape the copy: H.264 video, AAC audio and a target resolution of 720 by default. Videos are never upscaled. A lower constant rate factor means better quality and larger files." |
| 7 | 1:10–1:22 | CARD "Hardware transcoding": bullets "NVENC · NVIDIA", "Quick Sync · Intel", "VAAPI · AMD, Intel, NVIDIA", "RKMPP · Rockchip"; footnote "Experimental · larger files at similar settings". | Hardware transcoding | "A GPU can do the encoding. Frameleaf supports NVENC, Quick Sync, VAAPI and RKMPP. Hardware encoding is experimental and makes larger files than software at similar settings." |
| 8 | 1:22–1:37 | TERMINAL: `ls` shows `docker-compose.yml  hwaccel.transcoding.yml`. The editor opens `docker-compose.yml` at `immich-server:`; the commented lines are uncommented as typed: `extends:` / `file: hwaccel.transcoding.yml` / `service: quicksync` (replacing `cpu`). CALLOUT "WSL2 + VAAPI: vaapi-wsl". Then `docker compose up -d`. | hwaccel.transcoding.yml · service: quicksync | "Keep the transcoding acceleration file next to your compose file. In the server service, uncomment extends and change cpu to your backend, such as quicksync. For VAAPI on WSL2, use vaapi-wsl. Then recreate the containers." |
| 9 | 1:37–1:48 | SCREEN: Video playback proxies → group "Hardware Acceleration". CURSOR sets "Acceleration API" to "Quick Sync (requires 7th gen Intel CPU or later)". HIGHLIGHT the toggle "Hardware decoding" (on) with its line "Enables end-to-end acceleration instead of only accelerating encoding. May not work on all videos." | Acceleration API · Hardware decoding | "Back in Video playback proxies, set Acceleration API to match. Keep Hardware decoding on for end-to-end acceleration; it may not work on every video." |
| 10 | 1:48–1:57 | ZOOM on "Constant quality mode" (options Auto, ICQ, CQP) and "Preset (-preset)". CALLOUT "Jasper Lake · Elkhart Lake → CQP". | Constant quality mode · Preset | "On Jasper Lake or Elkhart Lake processors, set Constant quality mode to CQP. A slower preset narrows the quality gap." |
| 11 | 1:57–2:05 | ZOOM on the save bar; CURSOR clicks Review changes; "Review settings changes" lists the Acceleration API change; CURSOR clicks Save changes; notice "Settings saved." | Review changes · Save changes | "Review changes, then Save changes. New conversions use the GPU; existing copies do not need redoing." |
| 12 | 2:05–2:17 | SCREEN: Settings → Compute & jobs → Hardware & GPU; CURSOR clicks "Run check again"; the row "Video playback and export" reads "GPU in use"; ZOOM on "Test transcode ran on … · 1080p at …× real time" (device name blurred). | Video playback and export · GPU in use | "To check, open Hardware & GPU and run the check. Video playback and export should read GPU in use, and the test transcode says where it ran." |
| 13 | 2:17–2:28 | ZOOM on the Acceleration API help text: "This setting is 'best effort': it will fallback to software transcoding on failure." Then TERMINAL `docker compose logs -f immich-server` scrolling with no errors while Kayaking.mov converts. | Best effort | "Acceleration is best effort: if the device fails, Frameleaf falls back to software, so a clean log while converting is a good sign." |
| 14 | 2:28–2:42 | CARD "Limits": bullet 1 "NVIDIA and AMD: no VP9 encoding"; bullet 2 "Two-pass: NVENC only"; bullet 3 "Raspberry Pi: not supported". | Limits | "A few limits: NVIDIA and AMD cards cannot encode VP9, two-pass encoding works only with NVENC, and Raspberry Pi is not supported." |
| 15 | 2:42–2:45 | LOGO OUTRO | Next: OPS-08 · Storage & originals: the storage template | "Next up: Storage & originals: the storage template." |

## Voice-over (clean)

Not every browser or phone plays every video. Frameleaf keeps your original and, when needed, makes a playback copy that plays everywhere.

Open Settings, then Editing & playback, then Video playback proxies. Transcode policy decides which videos get a copy.

The default, Only videos not in an accepted format, converts HDR video, unusual pixel formats and codecs you have not accepted. Other choices also convert videos above the target resolution or bitrate, convert everything, or nothing at all, which can break playback on some devices.

Accepted video codecs, audio codecs and containers set what counts as accepted. Out of the box that is H.264 video with AAC, MP3 or Opus audio, in MOV, Ogg or WebM. Other containers are repackaged as MP4.

Encoding Options shape the copy: H.264 video, AAC audio and a target resolution of 720 by default. Videos are never upscaled. A lower constant rate factor means better quality and larger files.

[pause]

A GPU can do the encoding. Frameleaf supports NVENC, Quick Sync, VAAPI and RKMPP. Hardware encoding is experimental and makes larger files than software at similar settings.

Keep the transcoding acceleration file next to your compose file. In the server service, uncomment extends and change cpu to your backend, such as quicksync. For VAAPI on WSL2, use vaapi-wsl. Then recreate the containers.

Back in Video playback proxies, set Acceleration API to match. Keep Hardware decoding on for end-to-end acceleration; it may not work on every video.

On Jasper Lake or Elkhart Lake processors, set Constant quality mode to CQP. A slower preset narrows the quality gap.

Review changes, then Save changes. New conversions use the GPU; existing copies do not need redoing.

[pause]

To check, open Hardware & GPU and run the check. Video playback and export should read GPU in use, and the test transcode says where it ran.

Acceleration is best effort: if the device fails, Frameleaf falls back to software, so a clean log while converting is a good sign.

A few limits: NVIDIA and AMD cards cannot encode VP9, two-pass encoding works only with NVENC, and Raspberry Pi is not supported.

[pause]

Next up: Storage & originals: the storage template.

## Production notes

- Capture from a build of `master/frameleaf-implementation`. The docs say "Admin page under Video transcoding settings" and "Video Transcoding Settings"; the current build is Settings → Editing & playback → "Video playback proxies" (group "Video playback"). Inside, the groups are "Transcode Policy", "Encoding Options", "Hardware Acceleration", "Advanced" and "Real-time Transcoding [EXPERIMENTAL]". Real-time transcoding is off by default and is not covered.
- Policy option labels verified in the build (beat 4) and their doc keys: `all`, `optimal`, `bitrate`, `required` (default), `disabled`. Under `required`, video is transcoded when it is HDR, not yuv420p, or its codec is not accepted; audio when its codec is not accepted (system-settings.md "Transcode policy"). Containers not in the accepted list are remuxed to MP4 even when no stream needs transcoding.
- Defaults verified in the server config: H.264, AAC, accepted audio AAC/MP3/Opus, accepted containers MOV/Ogg/WebM, 720p, crf 23, preset ultrafast, max bitrate 0, acceleration Disabled, hardware decoding on. The doc's limitations say only encoding is accelerated "by default"; in the current build Hardware decoding is already on by default, so the VO says "keep" rather than "turn on".
- Compose: `docker/docker-compose.yml` has the commented `extends` block under `immich-server` with "set to one of [nvenc, quicksync, rkmpp, vaapi, vaapi-wsl]". The service key `immich-server` stays for compatibility; the VO says "the server service". The file ships with each Frameleaf release (docker/README.md); the doc's download link still points upstream, so keep URLs off screen.
- Acceleration API option labels: "NVENC (requires NVIDIA GPU)", "Quick Sync (requires 7th gen Intel CPU or later)", "VAAPI", "RKMPP (only on Rockchip SOCs)", "Disabled". The doc's Jasper Lake and Elkhart Lake note refers to "Hardware Acceleration → Constant quality mode → CQP", which matches the build.
- "Existing copies do not need redoing" follows the doc's note that transcoding jobs need not be rerun after enabling hardware acceleration.
- The GPU check's "Video playback and export" row checks the server container. Its purpose line mentions Studio exports; keep the zoom on the status. Blur the device name in the test transcode line.
- Unraid (doc "All-In-One - Unraid Setup") and single-compose inlining are covered for machine learning in OPS-05 and for platforms in OPS-23; not repeated here. QSV VP9 requirements and RKMPP tone-mapping steps stay in the written guide.
