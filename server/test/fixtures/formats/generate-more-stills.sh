#!/bin/sh
# The still fixtures FL-1356 added, made from fixtures generate.sh already wrote (so run that first when
# regenerating everything). These need encoders Alpine does not package (OpenJPEG in ImageMagick, jxrlib,
# GIMP), so the pinned way to run this one is Debian:
#
#   docker run --rm -v "$PWD/server/test/fixtures/formats:/out" debian:trixie-slim sh -c \
#     'apt-get update -qq && apt-get install -yqq --no-install-recommends imagemagick libjxr-tools gimp \
#        python3 >/dev/null 2>&1 && sh /out/generate-more-stills.sh'
#
# After regenerating, re-run verify-formats.mjs and commit the new files with any manifest change.
set -eu
cd "$(dirname "$0")"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
small=still/bmp-24.bmp # 96x72, lossless

# --- JPEG under its other names: the same bytes as the baseline ------------------------------------
for extension in jpe jfi jif jps; do cp jpeg/baseline.jpg "jpeg/baseline.$extension"; done

# --- JPEG 2000: the boxed file and the bare codestream, under each name they go by -----------------
magick "$small" still/jp2.jp2
magick "$small" still/j2k.j2k
cp still/jp2.jp2 still/jp2.jpf
cp still/jp2.jp2 still/jp2.jpx
cp still/j2k.j2k still/j2k.j2c
cp still/j2k.j2k still/j2k.jpc

# --- JPEG XR (Windows HD Photo) ---------------------------------------------------------------------
JxrEncApp -i "$small" -o still/jxr.jxr -q 0.9
cp still/jxr.jxr still/jxr.wdp
cp still/jxr.jxr still/jxr.hdp

# --- Other stills ----------------------------------------------------------------------------------
magick "$small" still/cursor.cur
magick "$small" still/fits.fits
magick "$small" still/qoi.qoi
magick "$small" still/pam.pam
cp still/tiff-bigtiff.tif still/bigtiff.btf
cp still/pict.pict still/pict.pct
printf '%s' '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="72"><rect width="96" height="72" fill="#268"/><circle cx="48" cy="36" r="24" fill="#fc3"/></svg>' |
  gzip -n -9 >still/svgz.svgz
# A real GIMP file: ImageMagick cannot write XCF.
magick "$small" "$tmp/small.png"
gimp-console-3.0 -i --batch-interpreter=plug-in-script-fu-eval --quit -b \
  "(let* ((image (car (gimp-file-load RUN-NONINTERACTIVE \"$tmp/small.png\")))) (gimp-file-save RUN-NONINTERACTIVE image \"$tmp/gimp.xcf\") (gimp-image-delete image))" \
  >/dev/null 2>&1
cp "$tmp/gimp.xcf" still/gimp.xcf

# --- PNG whose picture data fails its checksum: the pixels are all there ----------------------------
magick "$small" still/png.png
python3 - <<'PY'
data = bytearray(open('still/png.png', 'rb').read())
end = data.index(b'IEND') - 4  # the IDAT checksum is the four bytes before IEND's length
data[end - 1] ^= 0xFF
open('still/png-bad-crc.png', 'wb').write(data)
PY
