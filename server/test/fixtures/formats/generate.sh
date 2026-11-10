#!/bin/sh
# Regenerates the synthetic format fixtures beside this script. Everything here is made from test
# patterns, so nothing carries a third-party licence. Needs libjpeg-turbo 3 (cjpeg, jpegtran),
# ImageMagick 7, ffmpeg and Pillow; the pinned way to get them:
#
#   docker run --rm -v "$PWD/server/test/fixtures/formats:/out" alpine:3.22 sh -c \
#     'apk add --no-cache libjpeg-turbo-utils imagemagick imagemagick-jpeg imagemagick-tiff \
#        imagemagick-webp imagemagick-openexr ffmpeg py3-pillow >/dev/null && sh /out/generate.sh'
#
# Encoders are not byte-reproducible across versions: after regenerating, re-run verify-formats.mjs
# and commit the new files together with any manifest change.
set -eu
cd "$(dirname "$0")"
rm -rf jpeg still video design
mkdir -p jpeg still video design
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# One busy 320x240 picture: no flat mid-grey rows, so "how much of the picture is there" is measurable.
magick -seed 7 -size 320x240 plasma:fractal -depth 8 "$tmp/src.ppm"
magick "$tmp/src.ppm" -depth 16 "$tmp/src16.ppm"
# The uncompressed formats get a 96x72 copy so the corpus stays small.
magick "$tmp/src.ppm" -resize 96x72! "$tmp/small.ppm"
magick "$tmp/small.ppm" -depth 16 "$tmp/small16.ppm"

# --- JPEG: the shapes behind the "old JPEG shows as damaged" reports -------------------------------
cjpeg -quality 80 -outfile jpeg/baseline.jpg "$tmp/src.ppm"
size=$(wc -c <jpeg/baseline.jpg)
head -c $((size - 2)) jpeg/baseline.jpg >jpeg/missing-eoi.jpg           # only the end marker is gone
head -c $((size * 93 / 100)) jpeg/baseline.jpg >jpeg/truncated-tail.jpg  # most rows present
head -c $((size / 2)) jpeg/baseline.jpg >jpeg/half-rows.jpg              # about half the rows gone
{ printf 'JUNK%.0s' $(seq 128); cat jpeg/baseline.jpg; } >jpeg/junk-before-soi.jpg
# An Exif APP1 whose TIFF header points far outside the segment, then the untouched picture.
{
  printf '\377\330\377\341\000\032Exif\000\000II*\000\360\377\377\377BROKENEXIF'
  tail -c +3 jpeg/baseline.jpg
} >jpeg/broken-exif.jpg
jpegtran -progressive -outfile jpeg/progressive.jpg jpeg/baseline.jpg
jpegtran -arithmetic -outfile jpeg/arithmetic.jpg jpeg/baseline.jpg
cjpeg -precision 12 -quality 80 -outfile jpeg/12bit.jpg "$tmp/src16.ppm"
cjpeg -lossless 1 -outfile jpeg/lossless.jpg "$tmp/src.ppm"
# Pillow writes plain Adobe CMYK (transform 0); ImageMagick writes YCCK (transform 2).
python3 -c "from PIL import Image; Image.open('$tmp/src.ppm').convert('CMYK').save('jpeg/cmyk.jpg', quality=80)"
magick "$tmp/src.ppm" -colorspace CMYK -quality 80 jpeg/ycck.jpg

# --- Other stills, written by ImageMagick ---------------------------------------------------------
magick "$tmp/small.ppm" BMP3:still/bmp-24.bmp
magick "$tmp/small.ppm" -alpha set -channel A -evaluate set 50% +channel BMP:still/bmp-32-alpha.bmp
magick "$tmp/small.ppm" -colors 256 -compress RLE BMP3:still/bmp-rle8.bmp
magick "$tmp/small.ppm" BMP2:still/bmp-os2.bmp
# ffmpeg, not ImageMagick: its RGB565 BMP names the bitfields format and leaves the three colour masks out.
magick "$tmp/small.ppm" "$tmp/small.bmp"
ffmpeg -nostdin -v error -y -i "$tmp/small.bmp" -pix_fmt rgb565le -fflags +bitexact still/bmp-565.bmp
magick "$tmp/small.ppm" -compress None still/tga-24.tga
magick "$tmp/small.ppm" -compress RLE still/tga-rle.tga
magick "$tmp/small.ppm" -resize 64x64! -define icon:auto-resize=64,32,16 still/icon.ico
magick "$tmp/small.ppm" -compress LZW still/tiff-lzw.tif
magick "$tmp/small.ppm" -compress Zip -define tiff:tile-geometry=128x128 still/tiff-deflate-tiled.tif
magick "$tmp/small.ppm" -compress JPEG still/tiff-jpeg.tif
magick "$tmp/small.ppm" -colorspace CMYK -compress LZW still/tiff-cmyk.tif
magick "$tmp/small16.ppm" -depth 16 -compress Zip still/tiff-16bit.tif
magick "$tmp/small.ppm" -depth 32 -define quantum:format=floating-point -compress Zip still/tiff-float.tif
magick "$tmp/small.ppm" -compress LZW TIFF64:still/tiff-bigtiff.tif
magick "$tmp/small.ppm" still/pcx.pcx
magick "$tmp/small.ppm" -define dds:compression=dxt1 still/dds-dxt1.dds
magick "$tmp/small.ppm" -depth 10 still/dpx-10bit.dpx
magick "$tmp/small.ppm" still/cineon.cin
magick "$tmp/small.ppm" still/sgi.sgi
magick "$tmp/small.ppm" still/pict.pict
magick "$tmp/small.ppm" -compress Zip still/exr.exr

# --- Design: a flat PSD is all ImageMagick can write; generate-design.py writes the rest byte by byte
# (layered PSD with and without its flat picture, PSB, PDF, Illustrator, EPS, XCF, Fireworks PNG and the
# ZIP-based documents). It reads jpeg/baseline.jpg, so it runs after the JPEGs.
magick "$tmp/small.ppm" design/flat.psd
python3 generate-design.py >/dev/null

# --- Video: five frames of a test pattern per codec and container ---------------------------------
clip() { # clip <output> <ffmpeg output options...>
  out=$1
  shift
  ffmpeg -nostdin -v error -y -f lavfi -i testsrc2=size=160x120:rate=25 -frames:v 5 -an \
    -fflags +bitexact -flags:v +bitexact "$@" "video/$out"
}
clip h264.mp4 -c:v libx264 -pix_fmt yuv420p
clip h264.mkv -c:v libx264 -pix_fmt yuv420p
# Not ".ts": the server build would take a transport stream for TypeScript.
clip h264.m2ts -c:v libx264 -pix_fmt yuv420p -f mpegts
clip hevc.mp4 -c:v libx265 -x265-params log-level=error -pix_fmt yuv420p -tag:v hvc1
clip av1.mp4 -c:v libaom-av1 -cpu-used 8 -pix_fmt yuv420p
clip vp8.webm -c:v libvpx -pix_fmt yuv420p
clip vp9.webm -c:v libvpx-vp9 -pix_fmt yuv420p
clip prores.mov -c:v prores_ks -profile:v 0 -pix_fmt yuv422p10le
clip dnxhr.mxf -vf scale=256:144 -c:v dnxhd -profile:v dnxhr_lb -pix_fmt yuv422p
clip cineform.mov -c:v cfhd -pix_fmt yuv422p10le
clip mjpeg.avi -c:v mjpeg -pix_fmt yuvj420p
clip mpeg2.mpg -c:v mpeg2video -pix_fmt yuv420p
clip mpeg4.avi -c:v mpeg4 -pix_fmt yuv420p
clip wmv2.asf -c:v wmv2 -pix_fmt yuv420p
clip flv1.flv -c:v flv -pix_fmt yuv420p
clip jpeg2000.mov -c:v jpeg2000 -pix_fmt yuv420p
clip ffv1.mkv -c:v ffv1 -pix_fmt yuv420p
clip theora.ogv -c:v libtheora -pix_fmt yuv420p
# FL-1357: more containers and bare streams, each under the extension people have them as.
clip mjpeg.mjpeg -c:v mjpeg -pix_fmt yuvj420p -f mjpeg
clip mjpeg.mjpg -c:v mjpeg -pix_fmt yuvj420p -f mjpeg
clip mpeg1.m1v -c:v mpeg1video -pix_fmt yuv420p -f mpeg1video
clip mpeg2.m2v -c:v mpeg2video -pix_fmt yuv420p -f mpeg2video
clip mpeg2.m2p -c:v mpeg2video -pix_fmt yuv420p -f vob
clip h264.tp -c:v libx264 -pix_fmt yuv420p -f mpegts
clip h264.trp -c:v libx264 -pix_fmt yuv420p -f mpegts
clip theora.ogm -c:v libtheora -pix_fmt yuv420p -f ogg
clip mpeg2.wtv -c:v mpeg2video -pix_fmt yuv420p -f wtv
clip mpeg2.dvr-ms -c:v mpeg2video -pix_fmt yuv420p -f asf
clip h264.nut -c:v libx264 -pix_fmt yuv420p -f nut
clip mpeg2.gxf -vf scale=720:576 -c:v mpeg2video -pix_fmt yuv420p -f gxf
clip jpeg2000.mj2 -c:v jpeg2000 -pix_fmt yuv420p -f mov
clip vp9.ivf -c:v libvpx-vp9 -pix_fmt yuv420p -f ivf
clip h264.h264 -c:v libx264 -pix_fmt yuv420p -f h264
clip hevc.h265 -c:v libx265 -x265-params log-level=error -pix_fmt yuv420p -f hevc
clip hevc.hevc -c:v libx265 -x265-params log-level=error -pix_fmt yuv420p -f hevc
clip raw.y4m -pix_fmt yuv420p -f yuv4mpegpipe
clip dv.dif -vf scale=720:576 -c:v dvvideo -pix_fmt yuv420p -f rawvideo
clip h264.evo -c:v libx264 -pix_fmt yuv420p -f vob
# Cinema RAW stand-ins (no real BRAW, CRM, N-RAW or ARRIRAW HDE sample may be redistributed, and nothing open
# decodes them): a QuickTime file whose picture track names a codec ffmpeg does not have, and a file it
# cannot open at all. They prove such files are kept and never called damaged, not that they play.
for raw in braw:brhq crm:CRAW nev:nraw; do
  clip "cinema-raw-standin.${raw%%:*}" -c:v libx264 -pix_fmt yuv420p -f mov
  LC_ALL=C sed -i "s/avc1/${raw##*:}/g" "video/cinema-raw-standin.${raw%%:*}"
done
{ printf 'ARRI\022\064\126\170'; head -c 4088 /dev/zero; } >video/cinema-raw-standin.arx
# The index (moov) sits at the end of a plain MP4, so cutting the tail leaves a file nothing can open.
head -c $(($(wc -c <video/h264.mp4) * 6 / 10)) video/h264.mp4 >video/h264-no-index.mp4

find jpeg still video design -type f | sort | xargs wc -c
