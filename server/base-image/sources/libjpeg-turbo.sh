#!/usr/bin/env bash

set -e

: "${LIBJPEG_TURBO_REVISION:=$(jq -cr '.revision' libjpeg-turbo.json)}"

# Only the djpeg program, linked statically: the image's libjpeg stays jpegli. libjpeg-turbo 3 reads the
# JPEGs jpegli cannot (arithmetic coding, 12-bit samples, lossless), as a rung of the still ladder (FL-1356).
git clone https://github.com/libjpeg-turbo/libjpeg-turbo.git
cd libjpeg-turbo
git reset --hard "$LIBJPEG_TURBO_REVISION"

# ponytail: no SIMD (it would need nasm on x86): this decoder only sees the few files jpegli refuses.
cmake -B build \
  -DCMAKE_BUILD_TYPE=Release \
  -DENABLE_SHARED=OFF \
  -DENABLE_STATIC=ON \
  -DWITH_SIMD=OFF \
  -DWITH_TURBOJPEG=OFF \
  .
echo "Building djpeg using $(nproc) threads"
cmake --build build --target djpeg-static -- -j"$(nproc)"
install -m 755 build/djpeg-static /usr/local/bin/djpeg
install -D -m 644 LICENSE.md /usr/local/share/licenses/libjpeg-turbo/LICENSE.md
/usr/local/bin/djpeg -version 2>&1 | grep -q 'version 3\.'
cd .. && rm -rf libjpeg-turbo
