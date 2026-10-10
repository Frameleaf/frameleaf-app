#!/usr/bin/env bash

set -e

: "${LIBRAW_REVISION:=$(jq -cr '.revision' libraw.json)}"

git clone https://github.com/libraw/libraw.git
cd libraw
git reset --hard "$LIBRAW_REVISION"

autoreconf --install
./configure --enable-examples
echo "Building libraw using $(nproc) threads"
make -j"$(nproc)"
make install
test -x /usr/local/bin/dcraw_emu
cd .. && rm -rf libraw
ldconfig /usr/local/lib
