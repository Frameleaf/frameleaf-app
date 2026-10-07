#!/usr/bin/env bash
set -euo pipefail
revision="$(jq -er '.revision' libultrahdr.json)"
test "$(sha256sum libultrahdr-hdr.patch | cut -d ' ' -f 1)" = "$(jq -er '.patchChecksum' libultrahdr.json)"
git clone --filter=blob:none https://github.com/google/libultrahdr.git
git -C libultrahdr checkout --detach "$revision"
git -C libultrahdr apply ../libultrahdr-hdr.patch
# Decoder-only ISO HEIF port; adaptive HEIF encoding remains unsupported.
cmake -S libultrahdr -B libultrahdr/build \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON -DUHDR_BUILD_DEPS=OFF \
  -DUHDR_ENABLE_HEIF=ON -DUHDR_WRITE_XMP=ON -DUHDR_WRITE_ISO=ON \
  -DUHDR_ENABLE_GLES=OFF -DUHDR_BUILD_EXAMPLES=OFF -DUHDR_ENABLE_INSTALL=ON
cmake --build libultrahdr/build --parallel "$(nproc)"
cmake --install libultrahdr/build
rm -rf libultrahdr
ldconfig /usr/local/lib
