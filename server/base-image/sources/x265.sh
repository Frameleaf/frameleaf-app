#!/usr/bin/env bash
set -euo pipefail

version=$(jq -er '.version' x265.json)
checksum=$(jq -er '.sha256' x265.json)
wget -q "https://github.com/Multicorewareinc/x265/releases/download/$version/x265_$version.tar.gz" -O x265.tar.gz
printf '%s  x265.tar.gz\n' "$checksum" | sha256sum -c -
tar -xzf x265.tar.gz
source_dir="$PWD/x265_$version/source"
# Keep ordinary 8-bit HEIC encoding and add 10-bit to the same shared library.
cmake -S "$source_dir" -B x265-main10 -DCMAKE_BUILD_TYPE=Release \
  -DHIGH_BIT_DEPTH=ON -DEXPORT_C_API=OFF -DENABLE_SHARED=OFF -DENABLE_CLI=OFF -DENABLE_PIC=ON
cmake --build x265-main10 --parallel "$(nproc)"
mkdir x265-main
ln -s ../x265-main10/libx265.a x265-main/libx265_main10.a
cmake -S "$source_dir" -B x265-main -DCMAKE_BUILD_TYPE=Release \
  -DENABLE_CLI=OFF -DENABLE_SHARED=ON -DENABLE_PIC=ON -DLINKED_10BIT=ON \
  -DEXTRA_LIB=x265_main10.a -DEXTRA_LINK_FLAGS=-L.
cmake --build x265-main --parallel "$(nproc)"
cmake --install x265-main
rm -rf x265.tar.gz "x265_$version" x265-main10 x265-main
ldconfig /usr/local/lib
