# Live Photo motion fixture

`live-photo-motion.mp4` is a synthetic one-second blue frame, generated for the
HTTP Live Photo publication tests. It contains no personal or prototype media.

Reproduce it with:

```sh
ffmpeg -f lavfi -i color=c=blue:s=16x16:d=1:r=1 -c:v libx264 \
  -pix_fmt yuv420p -movflags +faststart -map_metadata -1 live-photo-motion.mp4
```
