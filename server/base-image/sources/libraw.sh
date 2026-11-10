#!/usr/bin/env bash

set -e

: "${LIBRAW_REVISION:=$(jq -cr '.revision' libraw.json)}"

git clone https://github.com/libraw/libraw.git
cd libraw
git reset --hard "$LIBRAW_REVISION"

autoreconf --install
# FL-1355: every optional decoder path is asked for by name and then proven, because configure only warns
# when a library is missing. USE_X3FTOOLS turns on the bundled (BSD) Sigma Foveon X3F reader.
# GoPro GPR and JPEG XL DNG are not built: both need the Adobe DNG SDK (LibRaw README.GoPro.txt).
./configure --enable-examples --enable-openmp --enable-jpeg --enable-zlib --enable-lcms CPPFLAGS="-DUSE_X3FTOOLS"
for flag in -DUSE_JPEG -DUSE_ZLIB -DUSE_LCMS2 -fopenmp -DUSE_X3FTOOLS; do
  grep -q -- "$flag" Makefile || { echo "LibRaw was configured without $flag" >&2; exit 1; }
done
echo "Building libraw using $(nproc) threads"
make -j"$(nproc)"
make install
test -x /usr/local/bin/dcraw_emu
grep -q x3f_new_from_file /usr/local/lib/libraw.so || { echo "LibRaw was built without X3F support" >&2; exit 1; }
cd .. && rm -rf libraw
ldconfig /usr/local/lib
