# Colour LUTs shipped with Frameleaf

## `dji-d-log-m-to-rec709.cube`

DJI's own D-Log M → Rec.709 conversion LUT, used to show DJI D-Log M video (detected from the
`color_md : dlog_m` line of the clip's `.SRT` sidecar) in normal colour in playback copies and
thumbnails (FL-1285). The original video is never changed.

- Source page: https://www.dji.com/downloads/softwares/mini-4-pro-dlog-to-rec709 (Mac v1.0)
- Downloaded from DJI's CDN: https://terra-1-g.djicdn.com/851d20f7b9f64838a34cd02351370894/140%20lut/DJI%20Mini%204%20Pro%20D-Log%20M%20to%20Rec.709%20V1_.cube
- Downloaded: 2026-11-07
- Size: 1,042,315 bytes
- SHA-256: `b18162854ab47702068410c33afa98a8cb6eef159fc5a04ce0e65fad0fd8947e`
- Contents: 33³ `.cube` 3D LUT; its header reads "Mavic 3 Pro, D-Log M, 2023-03-24" (DJI ships one
  D-Log M LUT across the family). Kept byte for byte as published; the server writes a copy with
  normalised line endings for ffmpeg.
- DJI publishes no licence terms for redistributing this file. The owner approved shipping it in this
  repository on 2026-11-07.
