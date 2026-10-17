#!/bin/sh
set -eu

if [ -e armnn ] || [ -L armnn ] || [ -e armnn-23.11 ] || [ -L armnn-23.11 ]; then
  printf '%s\n' 'Refusing to overwrite existing ArmNN files' >&2
  exit 1
fi

armnn_download_tmp=$(mktemp -d)
trap 'rm -rf "$armnn_download_tmp"' 0

curl -fSL "https://github.com/ARM-software/armnn/releases/download/v23.11/ArmNN-linux-x86_64.tar.gz" -o "$armnn_download_tmp/binaries.tar.gz"
curl -fSL "https://github.com/ARM-software/armnn/archive/refs/tags/v23.11.tar.gz" -o "$armnn_download_tmp/source.tar.gz"

mkdir armnn
tar -xzf "$armnn_download_tmp/binaries.tar.gz" -C armnn
tar -xzf "$armnn_download_tmp/source.tar.gz"
