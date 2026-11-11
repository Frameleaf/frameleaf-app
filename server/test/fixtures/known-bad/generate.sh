#!/bin/sh
# Regenerates the known-bad corpus stand-ins beside this script (FL-883). Each is made from an ffmpeg
# test pattern, so none carries a third-party licence. They stand in for camera files the corpus has
# no licence-clean sample of yet: an iPhone-style HDR10 HEVC clip, an `hev1`-tagged HEVC clip, and a
# very wide panorama. Needs ffmpeg with libx265 (any recent build; encoders are not byte-reproducible,
# so update server/test/fixtures/known-bad-corpus.json from the suite's report after regenerating).
set -eu
cd "$(dirname "$0")"
clip() { # clip <output> <ffmpeg output options...>
  out=$1
  shift
  ffmpeg -nostdin -v error -y -f lavfi -i testsrc2=size=320x240:rate=25 -frames:v 10 -an \
    -fflags +bitexact -flags:v +bitexact "$@" "$out"
}
# HDR10: 10-bit BT.2020 primaries with the PQ transfer, as phones and cameras record HDR video.
clip hevc-hdr10-pq.mp4 -c:v libx265 -pix_fmt yuv420p10le -tag:v hvc1 \
  -x265-params log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc \
  -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc
# `hev1` keeps the parameter sets in the stream, not the sample description; some players refuse it.
clip hevc-hev1.mp4 -c:v libx265 -x265-params log-level=error -pix_fmt yuv420p -tag:v hev1
# A 24000x3000 (72 MP) panorama: wide enough to hit size limits, small on disk.
ffmpeg -nostdin -v error -y -f lavfi -i testsrc2=size=24000x3000 -frames:v 1 -q:v 20 panorama-72mp.jpg
