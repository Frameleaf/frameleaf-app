# Generated media test fixtures

These fictional, AI-generated photos, avatars and demonstration clips are
retained unchanged from the reviewed sample test media formerly under
`design/frameleaf/template/public/media/`. They contain no personal library
media. Tests own these copies independently of the local design prototypes.

The video clips are generated demonstration footage. File hashes below pin
the exact samples used by the existing upload, playback and screenshot tests.

```json
[
  {
    "file": "kayak-demo.mp4",
    "sha256": "5b4e019ce659394e31cca606174d079f7cb3a694944eb1a479fefe68b1595904"
  },
  {
    "file": "forest-demo.mp4",
    "sha256": "bf9fe124520dc05146e7d3b027234a14e8ed758580330163459f29ef244145ba"
  },
  {
    "file": "hiking.png",
    "sha256": "1ad633f4f4bc0e2422c1c2fc71bebf1b1a240806776b34080c536b9f3abd7097"
  },
  {
    "file": "avatar-emma.png",
    "sha256": "e7a17437466517e2bf59723cf80e243972c4ad57190441f062a41f1c34ef8b8f"
  },
  {
    "file": "avatar-jamie.png",
    "sha256": "6d13775c248d429623b993d3c7125eed3b69058f7525e31be41b212073155937"
  },
  {
    "file": "title-screen-a.mp4",
    "sha256": "b4ce42f6afa806f059770a481d53d1f0adf8bbec613fd4c4d3393ec661c3487c"
  },
  {
    "file": "title-screen-b.mp4",
    "sha256": "1a4cd01e1c81ecfc353d4eecd53f1ff5b4c2b4947b0dce92bea3e25259def62d"
  },
  {
    "file": "title-screen-a-trimmed.mp4",
    "sha256": "1f0bb2b85531b868d20a0d038ccb44b2f23230fe15b4bd0afabc0e15f1001dc0"
  }
]
```

The `title-screen-*` clips (FL-651 video look-alikes) are synthetic ffmpeg test
patterns: a 4 s SMPTE-bars title card, 16 s of different footage, the same card
again; the trim is seconds 2-22 of the first, re-encoded.

```sh
ENC="-c:v libx264 -preset veryslow -crf 32 -pix_fmt yuv420p -an -movflags +faststart -map_metadata -1 -fflags +bitexact -flags:v +bitexact"
gen() {
  ffmpeg -y -f lavfi -i "smptebars=size=320x180:rate=24:duration=4" -f lavfi -i "$1" \
    -f lavfi -i "smptebars=size=320x180:rate=24:duration=4" \
    -filter_complex "[0:v][1:v][2:v]concat=n=3:v=1[v]" -map "[v]" $ENC "$2"
}
gen "testsrc2=size=320x180:rate=24:duration=16" title-screen-a.mp4
gen "mandelbrot=size=320x180:rate=24,trim=duration=16" title-screen-b.mp4
ffmpeg -y -ss 2 -i title-screen-a.mp4 -t 20 $ENC title-screen-a-trimmed.mp4
```
