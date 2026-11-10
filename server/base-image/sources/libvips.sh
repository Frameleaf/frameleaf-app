#!/usr/bin/env bash

set -e

: "${LIBVIPS_REVISION:=$(jq -cr '.revision' libvips.json)}"

# PDF and PDF-compatible Illustrator files (FL-1358) open through pdfium (BSD-3-Clause and Apache-2.0),
# never Ghostscript or poppler. Building pdfium needs Chromium's whole toolchain, so the pinned,
# checksummed build from pdfium-binaries is installed instead.
case "$(dpkg --print-architecture)" in
  amd64) pdfium_arch=x64 ;;
  arm64) pdfium_arch=arm64 ;;
  *) echo "no pdfium build for $(dpkg --print-architecture)" >&2; exit 1 ;;
esac
pdfium_version=$(jq -cr '.version' pdfium.json)
wget -q -O pdfium.tgz \
  "https://github.com/bblanchon/pdfium-binaries/releases/download/${pdfium_version}/pdfium-linux-${pdfium_arch}.tgz"
echo "$(jq -cr ".sha256.${pdfium_arch}" pdfium.json)  pdfium.tgz" | sha256sum -c -
mkdir pdfium && tar -xzf pdfium.tgz -C pdfium
install -m 644 pdfium/lib/libpdfium.so /usr/local/lib/
cp -r pdfium/include/. /usr/local/include/
# The licence texts travel with the library: /usr/local/lib is what the runtime image copies.
mkdir -p /usr/local/lib/pdfium-licenses
cp -r pdfium/LICENSE pdfium/licenses/. /usr/local/lib/pdfium-licenses/
mkdir -p /usr/local/lib/pkgconfig
cat >/usr/local/lib/pkgconfig/pdfium.pc <<PC
prefix=/usr/local
libdir=\${prefix}/lib
includedir=\${prefix}/include
Name: pdfium
Description: pdfium
Version: ${pdfium_version#chromium/}
Libs: -L\${libdir} -lpdfium
Cflags: -I\${includedir}
PC
rm -rf pdfium pdfium.tgz

git clone https://github.com/libvips/libvips.git
cd libvips
git reset --hard "$LIBVIPS_REVISION"
git apply ../libvips-patches/0001-put-other-loaders-ahead-of-dcrawload.patch

meson setup build --buildtype=release --libdir=lib -Dintrospection=disabled -Dtiff=disabled \
  -Dpdfium=enabled -Dpoppler=disabled
cd build
ninja install
cd .. && rm -rf libvips
ldconfig /usr/local/lib
