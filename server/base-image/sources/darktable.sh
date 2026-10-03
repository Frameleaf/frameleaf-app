#!/usr/bin/env bash
# Pinned CPU-native engine; run only in the existing image builder.
set -euo pipefail
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
pins=$(realpath darktable.json)
patches=$(realpath darktable-patches)
while IFS=$'\t' read -r name url checksum destination; do
  archive="$work/$name.tar.gz"
  wget --https-only --timeout=60 --tries=3 -q "$url" -O "$archive"
  printf '%s  %s\n' "$checksum" "$archive" | sha256sum --strict -c -
  if [ "$name" = lensfun ]; then target="$work/lensfun"; else target="$work/darktable/$destination"; fi
  mkdir -p "$target"
  tar -xzf "$archive" --strip-components=1 -C "$target"
done < <(jq -r '.inputs[] | [.name,.url,.sha256,.path] | @tsv' "$pins")
while IFS=$'\t' read -r name checksum; do
  printf '%s  %s\n' "$checksum" "$patches/$name" | sha256sum --strict -c -
  python3 "$patches/$name" "$work/darktable"
done < <(jq -r '.patches | to_entries[] | [.key,.value] | @tsv' "$pins")
cmake -S "$work/lensfun" -B "$work/lensfun-build" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local -DCMAKE_INSTALL_LIBDIR=lib \
  -DINSTALL_HELPER_SCRIPTS=OFF -DINSTALL_PYTHON_MODULE=OFF -DBUILD_DOC=OFF -DBUILD_TESTS=OFF
cmake --build "$work/lensfun-build" --parallel "$(nproc)"
cmake --install "$work/lensfun-build"
cmake -S "$work/darktable" -B "$work/darktable-build" -G Ninja \
  -DPROJECT_VERSION=5.6.1 -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local \
  -DCMAKE_INSTALL_LIBDIR=lib -DBINARY_PACKAGE_BUILD=ON -DRAWSPEED_ENABLE_WERROR=OFF \
  -DUSE_LIBRAW=ON -DDONT_USE_INTERNAL_LIBRAW=ON -DUSE_OPENMP=ON \
  -DUSE_OPENCL=OFF -DUSE_AI=OFF -DUSE_CAMERA_SUPPORT=OFF -DUSE_COLORD=OFF \
  -DUSE_MAP=OFF -DUSE_LUA=OFF -DUSE_KWALLET=OFF -DUSE_LIBSECRET=OFF \
  -DUSE_GRAPHICSMAGICK=OFF -DUSE_IMAGEMAGICK=OFF -DUSE_PORTMIDI=OFF \
  -DUSE_OPENJPEG=OFF -DUSE_JXL=OFF -DUSE_WEBP=OFF -DUSE_AVIF=OFF -DUSE_HEIF=OFF \
  -DUSE_XCF=OFF -DUSE_OPENEXR=OFF -DUSE_GMIC=OFF -DUSE_ICU=OFF -DUSE_SDL2=OFF \
  -DBUILD_PRINT=OFF -DBUILD_CMSTEST=OFF -DBUILD_RS_IDENTIFY=OFF -DBUILD_TESTING=OFF
# Reject a fallback to the unpopulated internal LibRaw tree.
grep -Eq '^libraw_LIBRARY:FILEPATH=/usr/local/lib/' "$work/darktable-build/CMakeCache.txt"
cmake --build "$work/darktable-build" --parallel "$(nproc)"
cmake --install "$work/darktable-build"
mkdir -p /usr/local/share/frameleaf/licenses
cp "$work/darktable/LICENSE" /usr/local/share/frameleaf/licenses/darktable-LICENSE
cp "$work/darktable/src/external/rawspeed/LICENSE" /usr/local/share/frameleaf/licenses/rawspeed-LICENSE
cp "$work/darktable/src/external/whereami/LICENSE.MIT" /usr/local/share/frameleaf/licenses/whereami-LICENSE.MIT
cp "$work/darktable/src/external/OpenCL/LICENSE" /usr/local/share/frameleaf/licenses/opencl-headers-LICENSE
cp "$work/lensfun/docs/lgpl-3.0.txt" /usr/local/share/frameleaf/licenses/lensfun-lgpl-3.0.txt
cp "$work/lensfun/docs/cc-by-sa-3.0.txt" /usr/local/share/frameleaf/licenses/lensfun-database-cc-by-sa-3.0.txt
ldconfig /usr/local/lib
node ./verify-darktable.mjs record /usr/local "$pins"
mkdir -p /build
node ./verify-darktable.mjs verify /usr/local /build/darktable-build-runtime.json /build/darktable-runtime-packages.txt
